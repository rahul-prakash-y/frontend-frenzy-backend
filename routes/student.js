const User = require('../models/User');
const Submission = require('../models/Submission');
const Team = require('../models/Team');
const PDFDocument = require('pdfkit');

module.exports = async function (fastify, opts) {
    /**
     * GET /api/student/my-report
     * Download the student's own performance report if published.
     */
    fastify.get('/my-report', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const student = await User.findById(userId).populate('team').lean();
            
            if (!student.isReportPublished) {
                return reply.code(403).send({ error: 'Your performance report has not been published yet.' });
            }

            // Reuse the report generation logic from superadmin (ideally this should be in a utility)
            // For now, I'll implement it here to ensure it works correctly.
            
            const submissions = await Submission.find({ student: userId })
                .populate('round')
                .sort({ 'round.createdAt': 1 })
                .lean();

            const pdfBuffer = await generateStudentReportBuffer(student, submissions);
            
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
};

// --- Helper Functions (Duplicated from superadmin for now to avoid refactoring complexity in this step) ---

async function generateStudentReportBuffer(student, submissions) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            // --- Colors & Styles ---
            const NAVY = '#1e293b';
            const PURPLE = '#581c87';
            const ACCENT = '#f59e0b';
            const LIGHT_BLUE = '#eff6ff';

            // --- Header Section ---
            doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
            doc.text('TECHNOLOGY', { align: 'center' });
            doc.moveDown(0.2);
            doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
            doc.moveDown(0.5);

            const pageWidth = doc.page.width;
            const barWidth = 100;
            doc.rect((pageWidth - barWidth) / 2, doc.y, barWidth, 3).fill(ACCENT);
            doc.moveDown(0.8);

            const pillWidth = 140;
            const pillHeight = 24;
            const pillX = (pageWidth - pillWidth) / 2;
            doc.roundedRect(pillX, doc.y, pillWidth, pillHeight, 12).fill(NAVY);
            doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('C-CAP REPORT', pillX, doc.y + 7, { width: pillWidth, align: 'center' });
            doc.moveDown(1.5);

            doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
            doc.moveDown(1);

            // Styled Title Box
            const titleBoxY = doc.y;
            doc.roundedRect(40, titleBoxY, pageWidth - 80, 45, 8).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();
            doc.fillColor(NAVY).fontSize(18).text('PERFORMANCE ANALYTICS', 55, titleBoxY + 14);
            doc.moveDown(2.5);

            // --- 1. STUDENT PROFILE ---
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).text('1. STUDENT PROFILE', 50, doc.y);
            doc.moveDown(0.8);

            const profileY = doc.y;
            const col1X = 60;
            const col2X = pageWidth / 2 + 30;

            const drawField = (label, value, x, y) => {
                doc.fillColor('#64748b').fontSize(10).text(label.toUpperCase(), x, y);
                doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text(value || 'N/A', x, y + 14);
            };

            drawField('Candidate Name', student.name, col1X, profileY);
            drawField('Student Identity', student.studentId, col2X, profileY);
            doc.moveDown(2.5);

            const nextY = doc.y;
            drawField('Team Assignment', student.team?.name || 'Independent', col1X, nextY);
            drawField('Department', student.department, col2X, nextY);
            doc.moveDown(3);

            // --- 2. PERFORMANCE SUMMARY ---
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).text('2. ASSESSMENT RECORD', 50, doc.y);
            doc.moveDown(1);

            // Table Header
            const tableTop = doc.y;
            doc.rect(40, tableTop, pageWidth - 80, 20).fill('#f1f5f9');
            doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold').text('ASSESSMENT ROUND', 50, tableTop + 6);
            doc.text('STATUS', 240, tableTop + 6);
            doc.text('SCORE', 340, tableTop + 6);
            doc.text('COMPLETION DATE', 430, tableTop + 6);
            doc.moveDown(1.2);

            let totalScore = 0;
            submissions.forEach((sub, i) => {
                const y = doc.y;
                if (y > 750) doc.addPage();
                
                doc.fillColor(NAVY).fontSize(10).font('Helvetica').text(sub.round?.name || 'Round', 50, y);
                doc.fontSize(9).text(sub.status, 240, y);
                doc.font('Helvetica-Bold').text(sub.score?.toString() || '0', 340, y);
                doc.font('Helvetica').fontSize(9).text(new Date(sub.updatedAt).toLocaleDateString(), 430, y);
                
                totalScore += (sub.score || 0);
                doc.moveDown(0.8);
                doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#f1f5f9').lineWidth(0.5).stroke();
                doc.moveDown(0.5);
            });

            doc.moveDown(1.5);
            doc.roundedRect(pageWidth - 220, doc.y, 180, 40, 8).fill(PURPLE);
            doc.fillColor('white').fontSize(12).font('Helvetica-Bold').text('AGGREGATE SCORE', pageWidth - 210, doc.y + 14, { width: 100, align: 'left' });
            doc.fontSize(16).text(totalScore.toFixed(2), pageWidth - 100, doc.y - 14, { width: 50, align: 'right' });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

async function generateTeamReportBuffer(team) {
    // Basic aggregation of member scores for team report
     return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const NAVY = '#1e293b';
            const INDIGO = '#4f46e5';
            const ACCENT = '#f59e0b';

            doc.font('Helvetica-Bold').fontSize(24).fillColor(NAVY).text('TEAM PERFORMANCE REPORT', { align: 'center' });
            doc.fontSize(16).fillColor(INDIGO).text(team.name.toUpperCase(), { align: 'center' });
            doc.moveDown(1);
            
            doc.rect(40, doc.y, doc.page.width - 80, 2).fill(ACCENT);
            doc.moveDown(2);

            doc.fontSize(14).fillColor(NAVY).text('TEAM ROSTER & INDIVIDUAL CONTRIBUTION');
            doc.moveDown(1);

            // Fetch submissions for all members
            const memberIds = team.members.map(m => m._id);
            const submissions = await Submission.find({ student: { $in: memberIds } }).populate('student').lean();

            const memberStats = team.members.map(member => {
                const memberSubs = submissions.filter(s => s.student._id.toString() === member._id.toString());
                const totalScore = memberSubs.reduce((sum, s) => sum + (s.score || 0), 0);
                return { name: member.name, studentId: member.studentId, totalScore };
            });

            memberStats.forEach(stat => {
                const y = doc.y;
                doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text(stat.name, 50, y);
                doc.fontSize(10).font('Helvetica').text(stat.studentId, 250, y);
                doc.fontSize(12).font('Helvetica-Bold').text(stat.totalScore.toFixed(2), 450, y);
                doc.moveDown(1);
            });

            const teamTotal = memberStats.reduce((sum, s) => sum + s.totalScore, 0);
            doc.moveDown(2);
            doc.rect(40, doc.y, doc.page.width - 80, 40).fill('#f8fafc');
            doc.fillColor(NAVY).fontSize(14).text('TOTAL TEAM SCORE', 60, doc.y + 12);
            doc.fontSize(20).text(teamTotal.toFixed(2), 400, doc.y - 16, { align: 'right', width: 100 });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}
