const crypto = require('crypto');
const mongoose = require('mongoose');
const Round = require('../models/Round');
const Submission = require('../models/Submission');
const User = require('../models/User');
const AdminOTP = require('../models/AdminOTP');
const { logActivity } = require('../utils/logger');
const { isStudentEligible } = require('../utils/eligibility');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit-table');
const { PDFDocument: PDFLibDoc } = require('pdf-lib');

// Helper to generate a secure 6-digit OTP
const generateOtp = () => {
    return crypto.randomInt(100000, 999999).toString();
};

module.exports = async function (fastify, opts) {
    /**
     * NEW: GET /api/rounds/my-certificates
     * Returns all rounds where the student has a certificate available.
     * Auth: Student
     */
    fastify.get('/my-certificates', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const studentId = request.user.userId;

            // Find all rounds that have certificates released and a template assigned in DB
            const rounds = await Round.find({ 
                certificatesReleased: true,
                'certificateTemplate.data': { $exists: true, $ne: null }
            }).lean();

            if (!rounds.length) return reply.send({ success: true, data: [] });


            const roundIds = rounds.map(r => r._id);

            // Find submissions for these rounds where student is a winner (hasCertificate)
            // Or where they are in the Top N
            const certificates = [];

            for (const round of rounds) {
                const submission = await Submission.findOne({ 
                    student: studentId, 
                    round: round._id,
                    status: { $in: ['SUBMITTED', 'COMPLETED'] }
                });

                if (!submission) continue;

                let isWinner = submission.hasCertificate;
                
                if (!isWinner) {
                    // Fallback check if flag not set (e.g. recalculated by admin later)
                    const topSubmissions = await Submission.find({ 
                        round: round._id, 
                        status: { $in: ['SUBMITTED', 'COMPLETED'] } 
                    })
                    .sort({ score: -1 })
                    .limit(round.winnerLimit || 10)
                    .select('student');
                    
                    isWinner = topSubmissions.some(s => s.student.toString() === studentId);
                }

                if (isWinner) {
                    certificates.push({
                        roundId: round._id,
                        roundName: round.name,
                        date: round.startTime || round.createdAt,
                        score: submission.score,
                        status: submission.status
                    });
                }
            }

            return reply.send({ success: true, data: certificates });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch certificates' });
        }
    });

    /**
     * 0. List All Rounds (GET /api/rounds)
     * Auth: Must use the authenticate hook (Student).
     */
    fastify.get('/', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            // Exclude sensitive OTP fields from the initial query for students
            const { getRoundsCache } = require('../services/cacheService');
            const rounds = getRoundsCache();

            const studentId = request.user.userId;
            const uploadsDir = path.join(__dirname, '../uploads');
            

            // Enrich rounds with the student's submission status & eligibility
            const enrichedRounds = await Promise.all(rounds.map(async (round) => {
                const [submission, eligibility] = await Promise.all([
                    Submission.findOne({ student: studentId, round: round._id }).select('status score'),
                    isStudentEligible(studentId, round._id)
                ]);

                // Determine if student is a "winner" if certificates are released
                let isWinner = false;
                if (round.certificatesReleased && submission && (submission.status === 'COMPLETED')) {
                    // Check persistent DB flag first
                    if (submission.hasCertificate) {
                        isWinner = true;
                    } else {
                        // Fallback/Safety: Recalculate if flag not set but they might be a winner
                        const topSubmissions = await Submission.find({ 
                            round: round._id, 
                            status: { $in: ['COMPLETED'] } 
                        })
                        .sort({ score: -1 })
                        .limit(round.winnerLimit || 10)
                        .select('student');
                        
                        isWinner = topSubmissions.some(s => s.student.toString() === studentId);
                    }
                }
                return {
                    ...round,
                    mySubmissionStatus: submission ? submission.status : null,
                    eligibility,
                    isWinner,
                    hasCertificate: !!(isWinner && round.certificatesReleased && round.certificateTemplate?.data)
                };
            }));

            return reply.code(200).send({ success: true, data: enrichedRounds });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch rounds' });
        }
    });

    /**
     * GET /api/rounds/:roundId/certificate
     * Student can download their own certificate if the round has released them and they qualify.
     */
    fastify.get('/:roundId/certificate', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const studentId = request.user.userId;

            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            if (!round.certificatesReleased) {
                return reply.code(403).send({ error: 'Certificates have not been released for this round yet.' });
            }

            // Verify if student is a "winner" (Top N)
            const submissions = await Submission.find({ 
                round: roundId, 
                status: { $in: ['SUBMITTED', 'COMPLETED'] } 
            })
                .sort({ score: -1 })
                .limit(round.winnerLimit || 10)
                .select('student');

            const isWinner = submissions.some(s => s.student.toString() === studentId);
            if (!isWinner) {
                return reply.code(403).send({ error: 'Certificate only available for top winners.' });
            }

            // Generate the certificate from DB
            const templateFile = round.certificateTemplate;

           if (!templateFile || !templateFile.data) return reply.code(400).send({ error: 'Certificate template not assigned or missing in DB for this round.' });
           const templateBuffer = templateFile.data;
            const contentType = templateFile.contentType || 'image/png';

            const user = await User.findById(studentId);
            const studentName = user?.name || 'Student';

            let pdfBuffer;

            if (contentType === 'application/pdf') {
                // Use pdf-lib for PDF templates
                const pdfDoc = await PDFLibDoc.load(templateBuffer);
                const { StandardFonts, rgb } = require('pdf-lib');
                const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
                
                const pages = pdfDoc.getPages();
                const firstPage = pages[0];
                const { width, height } = firstPage.getSize();
                
                const fontSize = 40;
                const textWidth = helveticaFont.widthOfTextAtSize(studentName, fontSize);
                
                firstPage.drawText(studentName, {
                    x: (width - textWidth) / 2,
                    y: height / 2.2,
                    size: fontSize,
                    font: helveticaFont,
                    color: rgb(30/255, 41/255, 59/255) // #1e293b
                });

                pdfBuffer = Buffer.from(await pdfDoc.save());
            } else {
                // Use pdfkit for image templates (existing logic)

            const doc = new PDFDocument({
                layout: 'landscape',
                size: 'A4',
                margin: 0
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));

 doc.image(templateBuffer, 0, 0, { width: doc.page.width, height: doc.page.height });            doc.font('Helvetica-Bold').fontSize(40).fillColor('#1e293b');
            
            const textWidth = doc.widthOfString(studentName);
            const x = (doc.page.width - textWidth) / 2;
            const y = doc.page.height / 2.2;

            doc.text(studentName, x, y);
            doc.end();

            pdfBuffer = await new Promise((resolve) => {
                doc.on('end', () => resolve(Buffer.concat(chunks)));
            });
        }

            reply.header('Content-Type', 'application/pdf');
            reply.header('Content-Disposition', `attachment; filename=${studentName.replace(/\s+/g, '_')}_certificate.pdf`);
            return reply.send(pdfBuffer);

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to download certificate' });
        }
    });

    /**
     * 1a. GET /api/rounds/:roundId/refresh-otp
     * Auto-rotates OTPs every 60s. Admin UI polls this every ~5s to show live countdown.
     * Auth: requireAdmin
     */
    fastify.get('/:roundId/refresh-otp', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        const adminId = request.user.userId;

        try {
            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            const OTP_TTL_MS = 60 * 1000; // 1 minute
            const now = new Date();

            let adminOtpDoc = await AdminOTP.findOne({ adminId, roundId });
            const issuedAt = adminOtpDoc?.otpIssuedAt ? new Date(adminOtpDoc.otpIssuedAt) : null;
            const age = issuedAt ? now - issuedAt : Infinity;

            // Auto-rotate if OTP is expired or was never issued for this admin
            if (!adminOtpDoc || age >= OTP_TTL_MS) {
                const startOtp = generateOtp();
                const endOtp = generateOtp();
                adminOtpDoc = await AdminOTP.findOneAndUpdate(
                    { adminId, roundId },
                    { startOtp, endOtp, otpIssuedAt: now },
                    { upsert: true, new: true }
                );
            }

            const expiresAt = new Date(new Date(adminOtpDoc.otpIssuedAt).getTime() + OTP_TTL_MS);
            const secondsLeft = Math.max(0, Math.ceil((expiresAt - new Date()) / 1000));

            return reply.code(200).send({
                success: true,
                data: {
                    startOtp: adminOtpDoc.startOtp,
                    endOtp: adminOtpDoc.endOtp,
                    otpIssuedAt: adminOtpDoc.otpIssuedAt,
                    expiresAt,
                    secondsLeft
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to refresh OTP' });
        }
    });

    /**
     * 1b. Admin OTP Generation for Test Group (POST /api/rounds/test-groups/:testGroupId/generate-otp)
     * Targets the FIRST section (roundOrder: 1) of the group.
     * Auth: requireAdmin
     */
    fastify.post('/test-groups/:testGroupId/generate-otp', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { testGroupId } = request.params;

        try {
            // Find the first section of this test group
            const firstRound = await Round.findOne({ testGroupId, roundOrder: 1 });
            if (!firstRound) return reply.code(404).send({ error: 'Test group or first section not found' });

            const startOtp = generateOtp();
            const endOtp = generateOtp();
            const adminId = request.user.userId;

            // Save for this admin
            await AdminOTP.findOneAndUpdate(
                { adminId, roundId: firstRound._id, testGroupId },
                { startOtp, endOtp, otpIssuedAt: new Date() },
                { upsert: true, new: true }
            );

            // Update round status global flag
            const round = await Round.findByIdAndUpdate(
                firstRound._id,
                { status: 'WAITING_FOR_OTP', isOtpActive: true },
                { new: true }
            );

            // Log activity
            await logActivity({
                action: 'OTP_GENERATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'TestGroup', id: testGroupId, label: `OTP for ${round.name}` },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: 'Test keys generated successfully',
                data: {
                    roundName: round.name,
                    startOtp,
                    endOtp
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate test keys' });
        }
    });

    /**
     * 1c. PATCH /api/rounds/test-groups/:testGroupId/status
     * Updates the status of the first section in a test group.
     * Auth: requireAdmin
     */
    fastify.patch('/test-groups/:testGroupId/status', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { testGroupId } = request.params;
        const { status, isOtpActive } = request.body;

        try {
            const firstRound = await Round.findOne({ testGroupId, roundOrder: 1 });
            if (!firstRound) return reply.code(404).send({ error: 'Test group or first section not found' });

            const round = await Round.findByIdAndUpdate(
                firstRound._id,
                {
                    ...(status && { status }),
                    ...(isOtpActive !== undefined && { isOtpActive })
                },
                { new: true }
            ).select('-startOtp -endOtp -otpIssuedAt');

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'TestGroup', id: testGroupId, label: `${round.name} status updated to ${status}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: round });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update test status' });
        }
    });

    /**
     * 1. Admin OTP Generation (POST /api/rounds/:roundId/generate-otp)
     * Auth: Must use the requireAdmin hook.
     */
    fastify.post('/:roundId/generate-otp', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;

        try {
            const startOtp = generateOtp();
            const endOtp = generateOtp();
            const adminId = request.user.userId;

            // Save for this admin
            await AdminOTP.findOneAndUpdate(
                { adminId, roundId },
                { startOtp, endOtp, otpIssuedAt: new Date() },
                { upsert: true, new: true }
            );

            const round = await Round.findByIdAndUpdate(
                roundId,
                { status: 'WAITING_FOR_OTP', isOtpActive: true },
                { new: true }
            );

            if (!round) {
                return reply.code(404).send({ error: 'Round not found' });
            }

            // Log OTP generation
            await logActivity({
                action: 'OTP_GENERATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: round.name },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: 'OTPs generated successfully',
                data: {
                    roundName: round.name,
                    startOtp,
                    endOtp
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate OTPs' });
        }
    });

    /**
     * 2. Student Start Round Gate (POST /api/rounds/:roundId/start)
     * Auth: Must use the authenticate hook (Student).
     */
    fastify.post('/:roundId/start', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;
        const { startOtp, isAutoJoin } = request.body;
        const studentId = request.user.userId;
        let submissionDetails = {};

        try {
            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });
 
            // ─── Time Window Check ──────────────────────────────────────────────────
            const now = new Date();
            if (round.startTime && now < new Date(round.startTime)) {
                return reply.code(403).send({
                    error: 'Test Not Started',
                    message: `This test is scheduled to start at ${new Date(round.startTime).toLocaleString()}.`
                });
            }
            if (round.endTime && now > new Date(round.endTime)) {
                return reply.code(403).send({
                    error: 'Test Ended',
                    message: `This test ended at ${new Date(round.endTime).toLocaleString()}.`
                });
            }

            // ─── Participation Eligibility Check ─────────────────────────────────────
            const eligibility = await isStudentEligible(studentId, roundId);
            if (!eligibility.eligible) {
                return reply.code(403).send({
                    error: 'Access Denied',
                    message: eligibility.message
                });
            }

            // Check if student already has a submission for this round first
            let submission = await Submission.findOne({ student: studentId, round: roundId });

            if (submission) {
                if (submission.status === 'SUBMITTED' || submission.status === 'DISQUALIFIED') {
                    return reply.code(403).send({ error: 'You have already completed or been disqualified from this round' });
                }
                // If IN_PROGRESS, they might be resuming after a crash. We just return the existing start time.
                return reply.code(200).send({
                    success: true,
                    message: 'Round resumed successfully',
                    startTime: submission.startTime,
                    durationMinutes: round.testDurationMinutes || round.durationMinutes,
                    extraTimeMinutes: submission.extraTimeMinutes || 0
                });
            }

            // If no existing submission, check authorization
            if (isAutoJoin) {
                if (!round.testGroupId || round.roundOrder === 1) {
                    return reply.code(403).send({ error: 'Auto-join sequence invalid for this endpoint' });
                }
                const prevRound = await Round.findOne({ testGroupId: round.testGroupId, roundOrder: round.roundOrder - 1 });
                if (!prevRound) return reply.code(403).send({ error: 'Sequence broken: Previous round not found' });
                const prevSub = await Submission.findOne({ student: studentId, round: prevRound._id, status: { $in: ['SUBMITTED', 'DISQUALIFIED'] } });
                if (!prevSub) return reply.code(403).send({ error: 'You must complete the previous section first' });
            } else {
                if (!startOtp) return reply.code(400).send({ error: 'startOtp is required' });
                if (round.status === 'LOCKED' || !round.isOtpActive) return reply.code(403).send({ error: 'Round is currently locked by admin' });

                // Verify OTP against AdminOTP collection
                const validOtpDoc = await AdminOTP.findOne({
                    roundId,
                    startOtp,
                    otpIssuedAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) } // Allow 2 min window for safety
                });

                if (!validOtpDoc) return reply.code(401).send({ error: 'Invalid or expired Start OTP' });

                // Track who conducted it
                submissionDetails = { conductedBy: validOtpDoc.adminId };
            }

            // Determine if we should inherit the clock from Round 1 of the Test Group
            let startTime = new Date();
            if (round.testGroupId && round.roundOrder > 1) {
                const firstRound = await Round.findOne({ testGroupId: round.testGroupId, roundOrder: 1 });
                if (firstRound) {
                    const firstSub = await Submission.findOne({ student: studentId, round: firstRound._id });
                    if (firstSub) {
                        startTime = firstSub.startTime;
                        // Inherit conductedBy and extraTimeMinutes for continuity
                        submissionDetails.conductedBy = firstSub.conductedBy || submissionDetails.conductedBy;
                        submissionDetails.extraTimeMinutes = firstSub.extraTimeMinutes || 0;
                    }
                }
            }

            // Create new submission tracking record
            submission = new Submission({
                student: studentId,
                round: roundId,
                status: 'IN_PROGRESS',
                startTime,
                ...submissionDetails
            });

            await submission.save();

            // Log section start
            await logActivity({
                action: 'SECTION_STARTED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Section', id: roundId, label: round.name },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: 'Round unlocked successfully',
                startTime: submission.startTime,
                durationMinutes: round.testDurationMinutes || round.durationMinutes,
                extraTimeMinutes: submission.extraTimeMinutes || 0
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to start round' });
        }
    });

    /**
     * 3. Student End Round Gate (POST /api/rounds/:roundId/submit)
     * Auth: Must use the authenticate hook (Student).
     */
    fastify.post('/:roundId/submit', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;
        const { endOtp, codeContent, pdfUrl, answers } = request.body;
        const studentId = request.user.userId;

        try {
            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            let nextRoundId = null;
            if (round.testGroupId) {
                const nextRound = await Round.findOne({ testGroupId: round.testGroupId, roundOrder: round.roundOrder + 1 });
                if (nextRound) nextRoundId = nextRound._id;
            }

            if (!nextRoundId) {
                if (!endOtp) return reply.code(400).send({ error: 'endOtp is required to finalize the test' });

                // Verify End OTP
                const validOtpDoc = await AdminOTP.findOne({
                    roundId,
                    endOtp,
                    otpIssuedAt: { $gte: new Date(Date.now() - 10 * 60 * 60 * 1000) } // endOtp is usually more stable, 10h window
                });

                if (!validOtpDoc) return reply.code(401).send({ error: 'Invalid End OTP' });
            }

            const submission = await Submission.findOne({ student: studentId, round: roundId });
            if (!submission) {
                return reply.code(400).send({ error: 'No active session found for this round' });
            }

            if (submission.status === 'SUBMITTED') {
                return reply.code(400).send({ error: 'Round already submitted' });
            }

            // Enforce the time limit (+ 2 min buffer for network latency) + extra time
            const now = new Date();
            const elapsedMinutes = (now - new Date(submission.startTime)) / 1000 / 60;
            const durationAllowed = round.testGroupId ? round.testDurationMinutes : round.durationMinutes;
            const extraMinutes = submission.extraTimeMinutes || 0;
            const bufferedDuration = durationAllowed + extraMinutes + 2;

            if (elapsedMinutes > bufferedDuration) {
                // Automatically disqualify for timing out completely and skipping front-end guards
                submission.status = 'DISQUALIFIED';
                submission.disqualificationReason = 'Submission timed out beyond duration limits';
                submission.endTime = now;
                await submission.save();
                return reply.code(403).send({ error: 'Time limit exceeded. Disqualified.' });
            }

            // Enforce the Test Window End Time
            if (round.endTime) {
                const windowEndWithExtra = new Date(new Date(round.endTime).getTime() + (extraMinutes * 60 * 1000) + (2 * 60 * 1000));
                if (now > windowEndWithExtra) {
                    submission.status = 'DISQUALIFIED';
                    submission.disqualificationReason = 'Submission timed out beyond test window limits';
                    submission.endTime = now;
                    await submission.save();
                    return reply.code(403).send({ error: 'Test window ended. Disqualified.' });
                }
            }

            // Successful Submission
            submission.status = 'SUBMITTED';
            submission.endTime = now;

            let parsedAnswers = {};
            if (answers) {
                parsedAnswers = typeof answers === 'object' ? answers : {};
                if (typeof answers === 'string') {
                    try { parsedAnswers = JSON.parse(answers); } catch (e) { }
                }
                submission.codeContent = typeof answers === 'object' ? JSON.stringify(answers) : answers;
            } else if (codeContent) {
                submission.codeContent = codeContent;
                try { parsedAnswers = JSON.parse(codeContent); } catch (e) { }
            }

            // --- Auto-evaluate MCQ questions ---
            const Question = require('../models/Question');
            let autoScore = 0;
            const answeredIds = Object.keys(parsedAnswers).filter(id => mongoose.Types.ObjectId.isValid(id));

            if (answeredIds.length > 0) {
                const questionsToEval = await Question.find({ _id: { $in: answeredIds }, type: 'MCQ' });
                for (const q of questionsToEval) {
                    const studentAnswer = String(parsedAnswers[q._id.toString()] || '').trim();
                    const correctAns = String(q.correctAnswer || '').trim();
                    if (correctAns && studentAnswer === correctAns) {
                        autoScore += (q.points || 0);
                    }
                }
            }
            submission.autoScore = autoScore;
            const totalManualScore = (submission.manualScores || []).reduce((sum, ms) => sum + (ms.score || 0), 0);

            let finalScore = autoScore + totalManualScore;
            if (round.isTeamTest) {
                finalScore = finalScore / 2;
            }
            submission.score = finalScore;

            if (pdfUrl) submission.pdfUrl = pdfUrl;

            await submission.save();

            // Log section submission
            await logActivity({
                action: 'SECTION_SUBMITTED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Section', id: roundId, label: round.name },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: 'Round successfully submitted',
                nextRoundId // informs the frontend to move to the next section automatically
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to submit round' });
        }
    });

    /**
     * 7. Report Anti-Cheat Violation (POST /api/rounds/:roundId/report-cheat)
     * Auth: Student
     */
    fastify.post('/:roundId/report-cheat', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;
        const { type, count } = request.body;
        const userId = request.user.userId;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(400).send({ error: 'Invalid Round ID' });
        }

        try {
            const submission = await Submission.findOne({ student: userId, round: roundId });
            if (!submission) return reply.code(404).send({ error: 'Submission session not found' });

            const user = await User.findById(userId);
            if (!user) return reply.code(404).send({ error: 'User not found' });

            if (type === 'TAB_SWITCH') {
                submission.tabSwitches = Math.max(submission.tabSwitches, count || 0);
            } else if (type === 'CHEAT_FLAG') {
                submission.cheatFlags += 1;
            }

            let shouldBan = false;
            let reason = '';

            // Loosened thresholds to prevent false positives on refresh/glitches
            if (submission.tabSwitches >= 3) {
                shouldBan = true;
                reason = 'Anti-cheat threshold (Tab Switch) exceeded.';
            } else if (submission.cheatFlags >= 3) {
                shouldBan = true;
                reason = 'Anti-cheat threshold (Copy-Paste/Split-Screen) exceeded.';
            }

            if (shouldBan) {
                user.isBanned = true;
                user.banReason = reason;
                user.tokenIssuedAfter = new Date(); // Invalidate current session
                submission.status = 'DISQUALIFIED';
                submission.disqualificationReason = reason;
                await user.save();
            }

            await submission.save();

            // Log the violation
            await logActivity({
                action: 'CHEAT_DETECTED',
                performedBy: { userId, studentId: request.user.studentId, name: request.user.name, role: request.user.role },
                target: { type: 'Submission', id: submission._id, label: `${type} flag recorded` },
                metadata: { type, count: submission.tabSwitches, flags: submission.cheatFlags, banned: shouldBan },
                ip: request.ip
            });

            return reply.send({
                success: true,
                banned: shouldBan,
                reason,
                tabSwitches: submission.tabSwitches,
                cheatFlags: submission.cheatFlags
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Security protocol failed to record violation' });
        }
    });

    /**
     * 4. Get Round Questions for Student (GET /api/rounds/:roundId/questions)
     * Auth: Must use the authenticate hook (Student).
     */
    fastify.get('/:roundId/questions', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;
        const studentId = request.user.userId;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(404).send({ error: 'Invalid Round ID format' });
        }

        try {
            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            const submission = await Submission.findOne({ student: studentId, round: roundId });

            if (!submission) {
                return reply.code(403).send({ error: 'Access denied. You must start the round first.' });
            }

            if (submission.status === 'DISQUALIFIED') {
                return reply.code(403).send({ error: 'ACCESS REVOKED: You have been disqualified for violating security protocols.' });
            }

            if (submission.status === 'SUBMITTED') {
                return reply.code(403).send({ error: 'Access denied.', reason: 'SUBMITTED_BLOCK' });
            }

            if (submission.status !== 'IN_PROGRESS') {
                return reply.code(403).send({ error: 'Access denied. Round session is not active.' });
            }

            const { getQuestionsByRound } = require('../services/cacheService');
            let assignedQuestions;

            if (submission.assignedQuestions && submission.assignedQuestions.length > 0) {
                // Student already has an assigned set — return it in the saved order
                const qMap = {};
                const allQ = getQuestionsByRound(roundId);
                allQ.forEach(q => { qMap[q._id.toString()] = q; });
                assignedQuestions = submission.assignedQuestions
                    .map(id => qMap[id.toString()])
                    .filter(Boolean);
            } else {
                // First load: build and persist the student's question set using In-Memory Cache
                const cachedQuestions = getQuestionsByRound(roundId);
                const allQuestions = [...cachedQuestions];

                // Group the available questions by their type field
                const groupedQuestions = {
                    MCQ: [],
                    CODE: [],
                    DEBUG: [],
                    FILL_BLANKS: [],
                    EXPLAIN: [],
                    SHORT_ANSWER: [],
                    OTHER: []
                };

                allQuestions.forEach(q => {
                    const type = q.type;
                    if (groupedQuestions[type]) {
                        groupedQuestions[type].push(q);
                    } else {
                        groupedQuestions.OTHER.push(q);
                    }
                });

                // Helper for deterministic PRNG shuffle
                const shuffleGroup = (group, type) => {
                    let selectedGroup = [...group];

                    if (round.shuffleQuestions !== false) {
                        // Seed includes the roundId, studentId, and question.type
                        const seed = `${roundId.toString()}_${studentId.toString()}_${type}`;

                        // cyrb53 hash for better avalanche on small string seeds
                        let h1 = 0xdeadbeef ^ seed.length, h2 = 0x41c6ce57 ^ seed.length;
                        for (let i = 0, ch; i < seed.length; i++) {
                            ch = seed.charCodeAt(i);
                            h1 = Math.imul(h1 ^ ch, 2654435761);
                            h2 = Math.imul(h2 ^ ch, 1597334677);
                        }
                        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
                        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
                        let h = 4294967296 * (2097151 & h2) + (h1 >>> 0); // 53-bit hash

                        const rand = () => {
                            // Mulberry32 PRNG
                            h = h + 1831565813 | 0;
                            let t = Math.imul(h ^ h >>> 15, 1 | h);
                            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
                            return ((t ^ t >>> 14) >>> 0) / 4294967296;
                        };

                        for (let i = selectedGroup.length - 1; i > 0; i--) {
                            const j = Math.floor(rand() * (i + 1));
                            [selectedGroup[i], selectedGroup[j]] = [selectedGroup[j], selectedGroup[i]];
                        }
                    }

                    return selectedGroup;
                };

                // Shuffle each group individually without hardcoded limits
                const mcqQuestions = shuffleGroup(groupedQuestions['MCQ'], 'MCQ');
                const codeQuestions = shuffleGroup(groupedQuestions['CODE'], 'CODE');
                const debugQuestions = shuffleGroup(groupedQuestions['DEBUG'], 'DEBUG');
                const fillBlanksQuestions = shuffleGroup(groupedQuestions['FILL_BLANKS'], 'FILL_BLANKS');
                const explainQuestions = shuffleGroup(groupedQuestions['EXPLAIN'], 'EXPLAIN');
                const shortAnswerQuestions = shuffleGroup(groupedQuestions['SHORT_ANSWER'], 'SHORT_ANSWER');
                const otherQuestions = shuffleGroup(groupedQuestions['OTHER'], 'OTHER');

                // Combine questions sequentially
                let selected = [...mcqQuestions, ...codeQuestions, ...debugQuestions, ...fillBlanksQuestions, ...explainQuestions, ...shortAnswerQuestions, ...otherQuestions];

                // Respect the questionCount limit if configured globally for the test
                if (round.questionCount && round.questionCount > 0) {
                    selected = selected.slice(0, round.questionCount);
                }

                // Persist the assignment so reconnects return the same set
                submission.assignedQuestions = selected.map(q => q._id);
                await submission.save();
                assignedQuestions = selected;
            }

            // Count total rounds so student can see "Round X of Y"
            let totalRounds = 1;
            let roundNumber = 1;
            let nextRoundId = null;

            if (round.testGroupId) {
                totalRounds = await Round.countDocuments({ testGroupId: round.testGroupId });
                roundNumber = round.roundOrder;
                const nextRound = await Round.findOne({ testGroupId: round.testGroupId, roundOrder: round.roundOrder + 1 });
                if (nextRound) nextRoundId = nextRound._id;
            } else {
                totalRounds = await Round.countDocuments({});
                const allRounds = await Round.find({}, '_id').sort({ createdAt: 1 }).lean();
                roundNumber = allRounds.findIndex(r => r._id.toString() === roundId) + 1;
            }

            return reply.code(200).send({
                success: true,
                data: {
                    round: {
                        name: round.name,
                        type: round.type,
                        durationMinutes: round.testDurationMinutes || round.durationMinutes,
                        status: round.status,
                        startTime: submission.startTime,
                        extraTimeMinutes: submission.extraTimeMinutes || 0,
                        totalRounds,
                        roundNumber,
                        hasNextRound: !!nextRoundId,
                        isTeamTest: round.isTeamTest
                    },
                    questions: assignedQuestions.map(q => ({
                        _id: q._id,
                        title: q.title,
                        description: q.description,
                        inputFormat: q.inputFormat,
                        outputFormat: q.outputFormat,
                        sampleInput: q.sampleInput,
                        sampleOutput: q.sampleOutput,
                        difficulty: q.difficulty,
                        points: q.points,
                        type: q.type,
                        category: q.category,
                        options: q.options
                    })),
                    debugInfo: {
                        fetchedQuestionsCount: assignedQuestions.length,
                        roundId: roundId,
                        submissionHasAssigned: !!(submission.assignedQuestions && submission.assignedQuestions.length > 0)
                    }
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch round questions' });
        }
    });

    /**
     * 5. Auto-Save Draft (POST /api/rounds/:roundId/autosave)
     * Auth: Must use the authenticate hook (Student).
     */
    fastify.post('/:roundId/autosave', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;
        const { codeContent, answers } = request.body;
        const studentId = request.user.userId;

        try {
            const submission = await Submission.findOne({ student: studentId, round: roundId });
            if (!submission) return reply.code(404).send({ error: 'Submission not found' });

            if (submission.status !== 'IN_PROGRESS') {
                // Silently return success to avoid noisy frontend errors once the session is done
                return reply.code(200).send({ success: true, message: 'Session no longer active' });
            }

            if (answers) {
                submission.codeContent = typeof answers === 'object' ? JSON.stringify(answers) : answers;
            } else if (codeContent !== undefined) {
                submission.codeContent = codeContent;
            }

            await submission.save();
            return reply.code(200).send({ success: true, extraTimeMinutes: submission.extraTimeMinutes });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to autosave' });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Task 1: Global Leaderboard  (GET /api/rounds/leaderboard)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Reads ONLY from the in-memory leaderboard cache — zero MongoDB hits.
     * The cache is refreshed every 60 seconds by the background service
     * started in server.js via startLeaderboardCache().
     *
     * Auth: authenticate (student or admin)
     */
    fastify.get('/leaderboard', { preValidation: [fastify.authenticateLight] }, async (request, reply) => {
        const { getLeaderboard, getCacheMetadata } = require('../services/leaderboardCache');

        const data = getLeaderboard();    // O(1) — pure in-memory read
        const metadata = getCacheMetadata();

        return reply.code(200).send({
            success: true,
            meta: {
                totalEntries: metadata.totalEntries,
                lastUpdatedAt: metadata.lastUpdatedAt,
                refreshIntervalSeconds: 60
            },
            data
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Task 5: Atomic Whitelist Update  (POST /api/rounds/:roundId/whitelist/add)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Adds one or more student ObjectIds to Round.allowedStudentIds using
     * MongoDB's $addToSet operator, which guarantees:
     *   • Atomicity  — no read-modify-write race conditions
     *   • Idempotency — duplicates are silently ignored by the DB engine
     *
     * Body: { studentIds: ["<ObjectId>", …] }
     * Auth: requireAdmin
     */
    fastify.post('/:roundId/whitelist/add', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        const { studentIds } = request.body;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(400).send({ error: 'Invalid Round ID format' });
        }

        if (!Array.isArray(studentIds) || studentIds.length === 0) {
            return reply.code(400).send({ error: 'studentIds must be a non-empty array' });
        }

        // Validate each ID before touching the DB
        const invalidIds = studentIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidIds.length > 0) {
            return reply.code(400).send({
                error: 'One or more studentIds are not valid ObjectIds',
                invalidIds
            });
        }

        try {
            // Task 5: $addToSet with $each for atomic, duplicate-safe bulk insert.
            // DO NOT use: Round.findById() → push() → save()  ← race condition!
            const updatedRound = await Round.findByIdAndUpdate(
                roundId,
                { $addToSet: { allowedStudentIds: { $each: studentIds } } },
                { new: true, select: 'name allowedStudentIds' }
            );

            if (!updatedRound) {
                return reply.code(404).send({ error: 'Round not found' });
            }

            await logActivity({
                action: 'WHITELIST_UPDATED',
                performedBy: {
                    userId: request.user?.userId,
                    name: request.user?.name,
                    role: request.user?.role
                },
                target: {
                    type: 'Round',
                    id: roundId,
                    label: `${studentIds.length} student(s) added to whitelist for ${updatedRound.name}`
                },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: `Whitelist updated atomically. ${studentIds.length} ID(s) processed (duplicates ignored).`,
                data: {
                    roundName: updatedRound.name,
                    totalWhitelisted: updatedRound.allowedStudentIds.length
                }
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update whitelist' });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Task 2 companion: Enqueue Submission  (POST /api/rounds/:roundId/enqueue-submit)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * High-traffic variant of the submit endpoint.
     * Pushes the payload to the in-memory submissionQueue and immediately
     * responds 200 OK. The background flush worker (startSubmissionQueue)
     * will batch-insert up to 50 docs every 5 seconds via insertMany().
     *
     * NOTE: Use this endpoint if you do NOT need instant DB confirmation.
     *       The original /:roundId/submit endpoint still performs a
     *       synchronous save for critical final submissions and remains
     *       the primary path. This endpoint is provided as an overflow
     *       path during peak traffic (400 concurrent students).
     *
     * Auth: authenticate (Student)
     */
    fastify.post('/:roundId/enqueue-submit', { preValidation: [fastify.authenticateLight] }, async (request, reply) => {
        const { roundId } = request.params;
        const { codeContent, pdfUrl, answers, autoScore } = request.body;
        const studentId = request.user.userId;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(400).send({ error: 'Invalid Round ID' });
        }

        const { enqueueSubmission, getQueueLength } = require('../services/submissionQueue');

        // Build the payload that matches the Submission schema fields
        const payload = {
            student: studentId,
            round: roundId,
            status: 'SUBMITTED',
            endTime: new Date(),
            codeContent: answers
                ? (typeof answers === 'object' ? JSON.stringify(answers) : answers)
                : (codeContent || ''),
            pdfUrl: pdfUrl || null,
            autoScore: autoScore || 0,
            score: autoScore || 0
        };

        const queueLength = enqueueSubmission(payload);

        fastify.log.info(`[SubmissionQueue] Enqueued for student ${studentId}. Queue depth: ${queueLength}`);

        return reply.code(200).send({
            success: true,
            message: 'Submission received and queued for processing.',
            queueDepth: queueLength
        });
    });

    /**
     * PRACTICE MODE
     * POST /api/rounds/:roundId/practice-start
     * Auth: Student
     *
     * Lets a student "enter" practice mode with ZERO DB writes.
     * No Submission document is created — this is purely a gate-check +
     * metadata return so the frontend can start a cosmetic countdown timer.
     *
     * Guards:
     *  - Round must exist
     *  - Round.isPracticeEnabled must be true
     */
    fastify.post('/:roundId/practice-start', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(400).send({ error: 'Invalid Round ID' });
        }

        try {
            const round = await Round.findById(roundId).select('name durationMinutes testDurationMinutes isPracticeEnabled practiceQuestionCount questionCount');
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            if (!round.isPracticeEnabled) {
                return reply.code(403).send({ error: 'Practice mode is not enabled for this round.' });
            }

            // No DB write — purely returning metadata for the frontend
            return reply.code(200).send({
                success: true,
                message: 'Practice session started. No answers will be saved.',
                roundName: round.name,
                // The timer shown to the student is purely cosmetic in practice mode
                durationMinutes: round.testDurationMinutes || round.durationMinutes,
                practiceQuestionCount: round.practiceQuestionCount ?? round.questionCount ?? null
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to start practice session' });
        }
    });

    /**
     * GET /api/rounds/:roundId/practice-questions
     * Auth: Student
     *
     * Returns shuffled questions for the round WITHOUT requiring an active
     * Submission session. The `correctAnswer` field is intentionally stripped
     * from every question before sending so students can not peek at answers.
     *
     * Guards:
     *  - Round must exist
     *  - Round.isPracticeEnabled must be true
     */
    fastify.get('/:roundId/practice-questions', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { roundId } = request.params;

        if (!mongoose.Types.ObjectId.isValid(roundId)) {
            return reply.code(400).send({ error: 'Invalid Round ID' });
        }

        try {
            const round = await Round.findById(roundId).select('isPracticeEnabled shuffleQuestions questionCount practiceQuestionCount');
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            if (!round.isPracticeEnabled) {
                return reply.code(403).send({ error: 'Practice mode is not enabled for this round.' });
            }

            const Question = require('../models/Question');

            // Fetch all questions linked to this round (same query as the real /questions route)
            let questions = await Question.find({ linkedRounds: roundId })
                .select('-correctAnswer') // ← Strip answers — students must not see them in practice
                .lean();

            // Shuffle if the round is configured to do so
            if (round.shuffleQuestions) {
                for (let i = questions.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [questions[i], questions[j]] = [questions[j], questions[i]];
                }
            }

            // Cap to practiceQuestionCount (or questionCount) if set
            const cap = round.practiceQuestionCount ?? round.questionCount ?? null;
            if (cap !== null && cap > 0) {
                questions = questions.slice(0, cap);
            }

            return reply.code(200).send({
                success: true,
                isPractice: true, // Tells the frontend to show the "Practice" banner / disable submit
                data: questions
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch practice questions' });
        }
    });
};
