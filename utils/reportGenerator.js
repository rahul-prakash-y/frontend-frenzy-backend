const PDFDocument = require('pdfkit-table');

/**
 * Generates a stylized PDF buffer for an individual student's performance report.
 * 
 * @param {Object} student - The student user document (lean)
 * @param {Array} submissions - List of student submissions (lean, populated with round)
 * @returns {Promise<Buffer>}
 */
async function generateStudentReportBuffer(student, submissions) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const NAVY = '#1e293b';
            const PURPLE = '#581c87';
            const ACCENT = '#f59e0b';
            const LIGHT_BLUE = '#eff6ff';

            // --- Header ---
            doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
            doc.text('TECHNOLOGY', { align: 'center' });
            doc.moveDown(0.2);
            doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
            doc.moveDown(0.5);

            const pageWidth = doc.page.width;
            doc.rect((pageWidth - 100) / 2, doc.y, 100, 3).fill(ACCENT);
            doc.moveDown(0.8);

            const pillWidth = 140;
            const pillX = (pageWidth - pillWidth) / 2;
            doc.roundedRect(pillX, doc.y, pillWidth, 24, 12).fill(NAVY);
            doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('C-CAP REPORT', pillX, doc.y + 7, { width: pillWidth, align: 'center' });
            doc.moveDown(1.5);

            doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
            doc.moveDown(1);

            // Title Box
            doc.roundedRect(40, doc.y, pageWidth - 80, 45, 8).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();
            doc.fillColor(NAVY).fontSize(18).text('PERFORMANCE ANALYTICS', 55, doc.y - 31);
            doc.moveDown(2.5);

            // --- Profile ---
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).text('1. STUDENT PROFILE', 50, doc.y);
            doc.moveDown(0.8);

            const startY = doc.y;
            const drawField = (label, value, x, y) => {
                doc.fillColor('#64748b').fontSize(10).text(label.toUpperCase(), x, y);
                doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text(value || 'N/A', x, y + 14);
            };

            drawField('Candidate Name', student.name, 60, startY);
            drawField('Student Identity', student.studentId, pageWidth / 2 + 30, startY);
            doc.moveDown(2.5);

            const row2Y = doc.y;
            drawField('Team Assignment', student.team?.name || 'Independent', 60, row2Y);
            drawField('Department', student.department, pageWidth / 2 + 30, row2Y);
            doc.moveDown(3);

            // --- Table ---
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).text('2. ASSESSMENT RECORD', 50, doc.y);
            doc.moveDown(1);

            const table = {
                headers: [
                    { label: "ROUND", property: 'round', width: 200 },
                    { label: "STATUS", property: 'status', width: 100 },
                    { label: "SCORE", property: 'score', width: 80 },
                    { label: "DATE", property: 'updatedAt', width: 100 }
                ],
                rows: submissions.map(s => [
                    s.round?.name || 'Assesment',
                    s.status,
                    String(s.score || 0),
                    new Date(s.updatedAt).toLocaleDateString('en-IN')
                ])
            };

            doc.table(table, {
                prepareHeader: () => doc.font("Helvetica-Bold").fontSize(9).fillColor('#475569'),
                prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
                    doc.font("Helvetica").fontSize(9).fillColor(NAVY);
                    if (indexRow % 2 === 0) doc.addBackground(rectRow, '#f8fafc', 0.5);
                }
            });

            const totalScore = submissions.reduce((sum, s) => sum + (s.score || 0), 0);
            doc.moveDown(2);
            doc.roundedRect(pageWidth - 220, doc.y, 180, 40, 8).fill(PURPLE);
            doc.fillColor('white').fontSize(12).font('Helvetica-Bold').text('AGGREGATE SCORE', pageWidth - 210, doc.y + 14, { width: 100 });
            doc.fontSize(16).text(totalScore.toFixed(2), pageWidth - 100, doc.y - 14, { width: 70, align: 'right' });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Generates a stylized PDF buffer for a team's performance report.
 * 
 * @param {Object} team - The team document (populated with members)
 * @param {Array} memberStats - Array of { name, studentId, attended, score }
 * @param {Number} rank - Global rank of the team
 * @param {Number} totalScore - Aggregate score of the team
 * @returns {Promise<Buffer>}
 */
async function generateTeamReportBuffer(team, memberStats, rank, totalScore) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const NAVY = '#1e293b';
            const PURPLE = '#581c87';
            const ACCENT = '#f59e0b';
            const LIGHT_BLUE = '#eff6ff';

            // --- Header ---
            doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
            doc.text('TECHNOLOGY', { align: 'center' });
            doc.moveDown(0.2);
            doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
            doc.moveDown(0.5);

            const pageWidth = doc.page.width;
            doc.rect((pageWidth - 100) / 2, doc.y, 100, 3).fill(ACCENT);
            doc.moveDown(0.8);

            const chipWidth = 180;
            const chipX = (pageWidth - chipWidth) / 2;
            doc.roundedRect(chipX, doc.y, chipWidth, 24, 12).fill(NAVY);
            doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('TEAM PERFORMANCE REPORT', chipX, doc.y + 7, { width: chipWidth, align: 'center' });
            doc.moveDown(2);

            // --- Team Summary Box ---
            const infoY = doc.y;
            doc.roundedRect(40, infoY, pageWidth - 80, 70, 10).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();
            doc.fillColor(NAVY).fontSize(18).font('Helvetica-Bold').text(team.name.toUpperCase(), 60, infoY + 15);
            doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`RANK #${rank} OVERALL`, 60, infoY + 38);

            doc.fillColor(PURPLE).fontSize(24).font('Helvetica-Bold').text(String(totalScore), pageWidth - 200, infoY + 15, { width: 140, align: 'right' });
            doc.fontSize(10).font('Helvetica-Bold').text('AGGREGATE POINTS', pageWidth - 200, infoY + 42, { width: 140, align: 'right' });
            doc.moveDown(4);

            // --- Squad Overview ---
            doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
            doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('1. SQUAD OVERVIEW', 50, doc.y);
            doc.moveDown(1);

            const table = {
                headers: [
                    { label: "Roll Number", property: 'studentId', width: 100 },
                    { label: "Member Name", property: 'name', width: 200 },
                    { label: "Attended", property: 'attended', width: 80 },
                    { label: "Contribution", property: 'score', width: 100 }
                ],
                rows: memberStats.map(m => [
                    m.studentId,
                    m.name,
                    String(m.attended || 0),
                    String(m.score || 0)
                ])
            };

            doc.table(table, {
                prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY),
                prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
                    doc.font("Helvetica").fontSize(10).fillColor(NAVY);
                    if (indexRow % 2 === 0) doc.addBackground(rectRow, LIGHT_BLUE, 0.4);
                }
            });

            // Footer
            doc.rect(40, doc.page.height - 60, pageWidth - 80, 6).fill(NAVY);

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = {
    generateStudentReportBuffer,
    generateTeamReportBuffer
};
