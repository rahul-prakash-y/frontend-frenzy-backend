const User = require('../models/User');
const Submission = require('../models/Submission');
const Team = require('../models/Team');
const Question = require('../models/Question');
const PracticeSubmission = require('../models/PracticeSubmission');
const Slot = require('../models/Slot');
const SlotChangeRequest = require('../models/SlotChangeRequest');
const PDFDocument = require('pdfkit-table');

module.exports = async function (fastify, opts) {
    /**
     * GET /api/student/my-report
     * Download the student's own performance report if published.
     */
    fastify.get('/my-report', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const student = await User.findById(userId).populate('team').lean();
            if (!student) return reply.code(404).send({ error: 'Student not found' });
            
            if (!student.isReportPublished) {
                return reply.code(403).send({ error: 'Your performance report has not been published yet.' });
            }

            const [contestSubmissions, practiceSubmissions] = await Promise.all([
                Submission.find({ student: userId }).populate('round').lean(),
                PracticeSubmission.find({ student: userId }).populate('round').lean()
            ]);

            const pdfBuffer = await new Promise(async (resolve, reject) => {
                try {
                    const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
                    let buffers = [];
                    doc.on('data', buffers.push.bind(buffers));
                    doc.on('end', () => resolve(Buffer.concat(buffers)));
                    doc.on('error', reject);

                    const NAVY = '#1e293b';
                    const PURPLE = '#581c87';
                    const AMBER = '#f59e0b';
                    const LIGHT_BLUE = '#eff6ff';

                    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
                    doc.text('TECHNOLOGY', { align: 'center' });
                    doc.moveDown(0.2);
                    doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
                    doc.moveDown(0.5);

                    const pageWidth = doc.page.width;
                    const barWidth = 100;
                    doc.rect((pageWidth - barWidth) / 2, doc.y, barWidth, 3).fill(AMBER);
                    doc.moveDown(0.8);

                    const pillWidth = 240;
                    const pillHeight = 24;
                    const pillX = (pageWidth - pillWidth) / 2;
                    doc.roundedRect(pillX, doc.y, pillWidth, pillHeight, 12).fill(NAVY);
                    doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('PERFORMANCE ANALYTICS REPORT', pillX, doc.y + 9, { width: pillWidth, align: 'center' });
                    doc.moveDown(1.5);

                    doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
                    doc.moveDown(1.5);

                    // --- 1. STUDENT PROFILE ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).text('1. STUDENT PROFILE', 50, doc.y);
                    doc.moveDown(0.8);

                    const profileY = doc.y;
                    const col1X = 60;
                    const col2X = pageWidth / 2 + 50;

                    const drawField = (label, value, x, y, width) => {
                        doc.fillColor('#64748b').fontSize(10).text(label.toUpperCase(), x, y);
                        doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text(value || 'N/A', x + 90, y, { align: 'right', width: width || ((pageWidth / 3) - 100) });
                        doc.moveTo(x, y + 14).lineTo(x + (pageWidth / 2) - 30, y + 14).strokeColor('#f1f5f9').dash(2, { space: 2 }).stroke().undash();
                    };

                    const attendedCount = contestSubmissions.filter(s => s.status !== 'NOT_STARTED').length;

                    drawField('Full Name', student.name, col1X, profileY);
                    drawField('Roll Number', student.studentId, col2X, profileY);
                    drawField('Department', student.department, col1X, profileY + 35);
                    drawField('Round Stats', `${attendedCount} Contests Attempted`, col2X, profileY + 35);

                    doc.moveDown(4.5);

                    // --- 2. ASSESSMENT SUMMARY (CONTESTS) ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('2. CONTEST PERFORMANCE', 50, doc.y);
                    doc.moveDown(1);

                    if (contestSubmissions.length > 0) {
                        const assessmentRows = [];
                        for (const s of contestSubmissions) {
                            const questions = await Question.find({
                                $or: [{ round: s.round?._id }, { linkedRounds: s.round?._id }]
                            });
                            const totalPoints = questions.reduce((acc, q) => acc + (q.points || 0), 0);
                            const qualified = s.score >= totalPoints * 0.5;
                            const resultText = qualified ? 'PASS' : 'FAIL';

                            assessmentRows.push([
                                new Date(s.createdAt).toLocaleDateString(),
                                s.round?.name || 'Untitled Round',
                                String(s.score ?? 0),
                                resultText
                            ]);
                        }

                        const assessmentTable = {
                            headers: [
                                { label: "Date", property: 'date', width: 100 },
                                { label: "Assessment Title", property: 'level', width: 220 },
                                { label: "Score", property: 'score', width: 80 },
                                { label: "Status", property: 'result', width: 100 }
                            ],
                            rows: assessmentRows
                        };

                        await doc.table(assessmentTable, {
                            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY),
                            prepareRow: (row, indexColumn) => {
                                doc.font("Helvetica").fontSize(10);
                                if (indexColumn === 3) {
                                    doc.fillColor(row[3] === 'PASS' ? '#16a34a' : '#dc2626');
                                } else {
                                    doc.fillColor(NAVY);
                                }
                            }
                        });
                    } else {
                        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#94a3b8').text('No contest attempts recorded.');
                    }
                    doc.moveDown(2);

                    // --- 3. PRACTICE PERFORMANCE ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('3. PRACTICE SESSIONS', 50, doc.y);
                    doc.moveDown(1);

                    if (practiceSubmissions.length > 0) {
                        const practiceRows = practiceSubmissions.map(s => ([
                            new Date(s.createdAt).toLocaleDateString(),
                            s.round?.name || 'Practice Test',
                            String(s.score ?? 0),
                            s.status
                        ]));

                        const practiceTable = {
                            headers: [
                                { label: "Date", property: 'date', width: 100 },
                                { label: "Practice Environment", property: 'level', width: 220 },
                                { label: "Score", property: 'score', width: 80 },
                                { label: "Activity", property: 'result', width: 100 }
                            ],
                            rows: practiceRows
                        };

                        await doc.table(practiceTable, {
                            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY),
                            prepareRow: () => doc.font("Helvetica").fontSize(10).fillColor(NAVY)
                        });
                    } else {
                        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#94a3b8').text('No practice records found.');
                    }

                    doc.end();
                } catch (err) {
                    reject(err);
                }
            });

            reply.type('application/pdf');
            reply.header('Content-Disposition', `attachment; filename=${student.studentId}_Report.pdf`);
            return reply.send(pdfBuffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate report' });
        }
    });

    /**
     * GET /api/student/my-team-report
     * Download the team's performance report if published.
     */
    fastify.get('/my-team-report', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const student = await User.findById(userId).populate('team').lean();
            
            if (!student.team) {
                return reply.code(404).send({ error: 'You are not assigned to any team.' });
            }

            const team = await Team.findById(student.team._id).populate('members').lean();
            
            if (!team.isReportPublished) {
                return reply.code(403).send({ error: 'The team performance report has not been published yet.' });
            }

            const pdfBuffer = await generateTeamReportBuffer(team);
            
            reply.type('application/pdf');
            reply.header('Content-Disposition', `attachment; filename=${team.name.replace(/\s+/g, '_')}_Team_Report.pdf`);
            return reply.send(pdfBuffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate team report' });
        }
    });

    /**
     * GET /api/student/my-slots
     * Returns all slots assigned to the student's team across all rounds.
     */
    fastify.get('/my-slots', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const user = await User.findById(userId).select('team').lean();
            if (!user) return reply.code(404).send({ error: 'User not found' });

            if (!user.team) {
                return reply.code(200).send({ success: true, data: [], message: 'You are not assigned to any team yet.' });
            }

            const slots = await Slot.find({ teams: user.team })
                .populate('round', 'name description status startTime endTime')
                .sort({ startTime: 1 })
                .lean();

            return reply.code(200).send({ success: true, data: slots });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch slot information' });
        }
    });

    /**
     * POST /api/student/slot-change-request
     * Submit a request to change the student's assigned slot for a round.
     * Body: { roundId, requestedSlotId, reason }
     */
    fastify.post('/slot-change-request', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const { roundId, requestedSlotId, reason } = request.body;

            if (!roundId || !requestedSlotId || !reason) {
                return reply.code(400).send({ error: 'roundId, requestedSlotId, and reason are required' });
            }

            const user = await User.findById(userId).select('team').lean();
            if (!user) return reply.code(404).send({ error: 'User not found' });
            if (!user.team) return reply.code(400).send({ error: 'You must be assigned to a team to request a slot change.' });

            // Find the student's current slot for this round
            const currentSlot = await Slot.findOne({ round: roundId, teams: user.team });
            if (!currentSlot) {
                return reply.code(404).send({ error: 'No slot is currently assigned to your team for this round.' });
            }

            // Validate the requested slot exists and belongs to the same round
            const requestedSlot = await Slot.findById(requestedSlotId);
            if (!requestedSlot) {
                return reply.code(404).send({ error: 'Requested slot not found.' });
            }
            if (requestedSlot.round.toString() !== roundId) {
                return reply.code(400).send({ error: 'Requested slot does not belong to the specified round.' });
            }
            if (currentSlot._id.toString() === requestedSlotId) {
                return reply.code(400).send({ error: 'You are already assigned to this slot.' });
            }

            // Check if the student already has a pending request for this round
            const existingRequest = await SlotChangeRequest.findOne({
                student: userId,
                round: roundId,
                status: 'PENDING'
            });
            if (existingRequest) {
                return reply.code(400).send({ error: 'You already have a pending slot change request for this round.' });
            }

            const changeRequest = new SlotChangeRequest({
                student: userId,
                round: roundId,
                currentSlot: currentSlot._id,
                requestedSlot: requestedSlotId,
                reason: reason.trim()
            });
            await changeRequest.save();

            return reply.code(201).send({
                success: true,
                message: 'Slot change request submitted successfully.',
                data: changeRequest
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to submit slot change request' });
        }
    });

    /**
     * GET /api/student/slot-change-requests
     * View the student's own slot change request history.
     */
    fastify.get('/slot-change-requests', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;

            const requests = await SlotChangeRequest.find({ student: userId })
                .populate('round', 'name')
                .populate('currentSlot', 'label startTime endTime')
                .populate('requestedSlot', 'label startTime endTime')
                .populate('reviewedBy', 'name')
                .sort({ createdAt: -1 })
                .lean();

            return reply.code(200).send({ success: true, data: requests });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch slot change requests' });
        }
    });
};

// --- Helper Functions ---

async function generateTeamReportBuffer(team) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const NAVY = '#1e293b';
            const PURPLE = '#581c87';
            const AMBER = '#f59e0b';
            const LIGHT_BLUE = '#eff6ff';

            // Header
            doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
            doc.text('TECHNOLOGY', { align: 'center' });
            doc.moveDown(0.2);
            doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
            doc.moveDown(0.5);
            const pageWidth = doc.page.width;
            doc.rect((pageWidth - 100) / 2, doc.y, 100, 3).fill(AMBER);
            doc.moveDown(0.8);
            const chipWidth = 240;
            const chipHeight = 24;
            const chipX = (pageWidth - chipWidth) / 2;
            doc.roundedRect(chipX, doc.y, chipWidth, chipHeight, 12).fill(NAVY);
            doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('TEAM PERFORMANCE ANALYTICS', chipX, doc.y + 9, { width: chipWidth, align: 'center' });
            doc.moveDown(2);

            // Fetch submissions for all members
            const memberIds = team.members.map(m => m._id);
            const [contestSubmissions, practiceSubmissions] = await Promise.all([
                Submission.find({ student: { $in: memberIds } }).lean(),
                PracticeSubmission.find({ student: { $in: memberIds } }).lean()
            ]);

            const memberStats = team.members.map(member => {
                const memberContests = contestSubmissions.filter(s => s.student.toString() === member._id.toString());
                const memberPractice = practiceSubmissions.filter(s => s.student.toString() === member._id.toString());
                
                const contestScore = memberContests.reduce((sum, s) => sum + (s.score || 0), 0);
                const practiceScore = memberPractice.reduce((sum, s) => sum + (s.score || 0), 0);
                const totalScore = contestScore + practiceScore;

                return { 
                    name: member.name, 
                    studentId: member.studentId, 
                    contestScore, 
                    practiceScore, 
                    totalScore 
                };
            });

            const teamTotalScore = memberStats.reduce((sum, s) => sum + s.totalScore, 0);

            // Team Info Box
            const infoY = doc.y;
            doc.roundedRect(40, infoY, pageWidth - 80, 70, 10).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();
            doc.fillColor(NAVY).fontSize(18).font('Helvetica-Bold').text(team.name.toUpperCase(), 60, infoY + 15);
            doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`TEAM SQUAD COMPOSITION`, 60, infoY + 38);
            doc.fillColor(PURPLE).fontSize(24).font('Helvetica-Bold').text(teamTotalScore.toFixed(2), pageWidth - 200, infoY + 15, { width: 140, align: 'right' });
            doc.fontSize(10).font('Helvetica-Bold').fillColor(PURPLE).text('AGGREGATE TEAM POINTS', pageWidth - 200, infoY + 42, { width: 140, align: 'right' });
            doc.moveDown(4);

            // 1. MEMBER CONTRIBUTION BREAKDOWN
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('1. MEMBER CONTRIBUTION BREAKDOWN', 50, doc.y);
            doc.moveDown(1);

            const table = {
                headers: [
                    { label: "Roll Number", property: 'studentId', width: 90 },
                    { label: "Member Name", property: 'name', width: 160 },
                    { label: "Contest Pts", property: 'contest', width: 80 },
                    { label: "Practice Pts", property: 'practice', width: 80 },
                    { label: "Total Contrib.", property: 'total', width: 100 }
                ],
                rows: memberStats.map(m => [
                    m.studentId,
                    m.name,
                    m.contestScore.toFixed(1),
                    m.practiceScore.toFixed(1),
                    m.totalScore.toFixed(1)
                ])
            };

            await doc.table(table, {
                prepareHeader: () => doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY),
                prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
                    doc.font("Helvetica").fontSize(9).fillColor(NAVY);
                }
            });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}
