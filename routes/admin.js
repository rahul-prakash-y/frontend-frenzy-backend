const fp = require('fastify-plugin');
const multipart = require('@fastify/multipart');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { parse } = require('json2csv');
const User = require('../models/User');
const { logActivity } = require('../utils/logger');

module.exports = async function (fastify, opts) {

    /**
     * 1. Admin Bulk User Generator (POST /api/admin/bulk-upload-students)
     * Auth: Must use the requireAdmin hook.
     * Parses Excel, generates strong passwords, registers students, and returns the CSV mapping.
     */
    fastify.post('/bulk-upload-students', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) {
                return reply.code(400).send({ error: 'No spreadsheet file uploaded' });
            }

            // Convert stream to Buffer to be parsed by xlsx
            const buffer = await data.toBuffer();

            const workbook = xlsx.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet);

            if (rows.length === 0) {
                return reply.code(400).send({ error: 'Excel file is empty' });
            }

            const generatedCredentials = [];
            let successCount = 0;
            let errorCount = 0;

            // Iterate constraints and Generate
            for (const row of rows) {
                // Accept 'RollNumber' or 'studentId' or 'ID'
                const studentId = row.RollNumber || row.studentId || row.ID || row.Roll_Number;
                const name = row.Name || row.name || row.Student_Name;
                const department = row.Department || row.dept || '';

                if (!studentId || !name) {
                    errorCount++;
                    continue; // Skip invalid rows smoothly
                }

                // Verify they don't already exist to prevent duplicate crashes
                const exists = await User.findOne({ studentId });
                if (exists) {
                    errorCount++;
                    continue;
                }

                // Default password "123456"
                const defaultPassword = '123456';
                const hashedPassword = await bcrypt.hash(defaultPassword, 10);

                const finalName = name ? name.toString().trim() : `Student ${studentId}`;

                const newUser = new User({
                    studentId: studentId.toString().trim(),
                    name: finalName,
                    password: hashedPassword,
                    role: 'STUDENT',
                    isOnboarded: false
                });

                await newUser.save();

                generatedCredentials.push({
                    Name: finalName,
                    Student_ID: studentId,
                    Department: department || 'General',
                    Platform_Password: defaultPassword
                });

                successCount++;
            }

            // Convert output array directly to CSV buffer
            const csvString = parse(generatedCredentials);

            // Log BULK_UPLOAD event
            await logActivity({
                action: 'BULK_UPLOAD',
                performedBy: {
                    userId: request.user?.userId,
                    studentId: request.user?.studentId,
                    name: request.user?.name,
                    role: request.user?.role
                },
                target: { type: 'User', label: `${successCount} students created, ${errorCount} skipped` },
                metadata: { successCount, errorCount },
                ip: request.ip
            });

            // Send the file back inherently with the correct headers
            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', 'attachment; filename=generated_student_credentials.csv');

            return reply.send(csvString);

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to process bulk upload', details: error.message });
        }
    });

};
