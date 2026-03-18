const mongoose = require('mongoose');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const Round = require('../models/Round');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');
const AdminOTP = require('../models/AdminOTP');
const Team = require('../models/Team');
const { logActivity } = require('../utils/logger');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit-table');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

module.exports = async function (fastify, opts) {

    /**
     * POST /api/superadmin/rounds
     * Super Admin can create new Rounds/Tests dynamically
     */
    fastify.post('/rounds', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const {
                name, description, durationMinutes, type,
                questionCount, shuffleQuestions,
                testGroupId, testDurationMinutes, roundOrder,
                maxParticipants, startTime, endTime
            } = request.body;

            if (!name) return reply.code(400).send({ error: 'Round name is required' });

            const round = new Round({
                name,
                description: description || '',
                durationMinutes: durationMinutes || 60,
                status: 'LOCKED',
                isOtpActive: false,
                type: type || 'GENERAL',
                questionCount: questionCount === undefined ? null : (questionCount === '' ? null : Number(questionCount)),
                shuffleQuestions: shuffleQuestions === undefined ? true : Boolean(shuffleQuestions),
                testGroupId: testGroupId || null,
                testDurationMinutes: testDurationMinutes || null,
                roundOrder: roundOrder || 1,
                maxParticipants: maxParticipants || null,
                startTime: startTime || null,
                endTime: endTime || null
            });

            const savedRound = await round.save();
            const data = await Round.findById(savedRound._id).select('-startOtp -endOtp -otpIssuedAt');

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: data._id, label: data.name },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create round' });
        }
    });

    /**
     * POST /api/superadmin/rounds/:roundId/certificate-template
     * Upload a PDF template for a specific round.
     */
    fastify.post('/rounds/:roundId/certificate-template', { preValidation: [fastify.requireSuperAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No PDF file uploaded' });

            if (data.mimetype !== 'application/pdf') {
                return reply.code(400).send({ error: 'Only PDF files are allowed as certificate templates' });
            }

            const uploadsDir = path.join(__dirname, '../uploads');
            if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
            }

            const filename = `template_${roundId}_${Date.now()}.pdf`;
            const filePath = path.join(uploadsDir, filename);
            
            // Save file
            const buffer = await data.toBuffer();
            fs.writeFileSync(filePath, buffer);

            const round = await Round.findByIdAndUpdate(roundId, { certificateTemplate: filename }, { new: true });
            if (!round) {
                // Cleanup file if round not found
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                return reply.code(404).send({ error: 'Round not found' });
            }

            await logActivity({
                action: 'UPLOADED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: `Certificate template for ${round.name}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Certificate template uploaded successfully', data: { certificateTemplate: filename } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to upload certificate template' });
        }
    });


    /**
     * 1. GET /api/superadmin/audit-logs
     * Returns all submissions across all rounds, enriched with student + round info.
     */
    fastify.get('/audit-logs', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId, search, page = 1, limit = 20 } = request.query;

            let filter = {};
            if (roundId) filter.round = roundId;

            // If search is provided, we need to find students or rounds that match the search string
            if (search) {
                const searchRegex = new RegExp(search, 'i');
                const [matchingStudents, matchingRounds] = await Promise.all([
                    User.find({
                        $or: [
                            { studentId: searchRegex },
                            { name: searchRegex }
                        ]
                    }).select('_id'),
                    Round.find({ name: searchRegex }).select('_id')
                ]);

                const studentIds = matchingStudents.map(s => s._id);
                const rIds = matchingRounds.map(r => r._id);

                filter.$or = [
                    { student: { $in: studentIds } },
                    { round: { $in: rIds } }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [submissions, total] = await Promise.all([
                Submission.find(filter)
                    .populate('student', 'studentId name role isBanned')
                    .populate('round', 'name status type')
                    .populate('conductedBy', 'name')
                    .populate('manualScores.questionId', 'title points type')
                    .populate('manualScores.adminId', 'name')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum),
                Submission.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: submissions,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch audit logs' });
        }
    });

    /**
     * GET /api/superadmin/attendance
     * Returns student attendance based on successful OTP entry
     */
    fastify.get('/attendance', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, page = 1, limit = 20 } = request.query;

            let filter = { conductedBy: { $ne: null } };

            if (search) {
                const searchRegex = new RegExp(search, 'i');
                const [matchingStudents, matchingAdmins, matchingRounds] = await Promise.all([
                    User.find({
                        $or: [
                            { studentId: searchRegex },
                            { name: searchRegex }
                        ]
                    }).select('_id'),
                    User.find({ name: searchRegex, role: { $in: ['ADMIN', 'SUPER_ADMIN'] } }).select('_id'),
                    Round.find({ name: searchRegex }).select('_id')
                ]);

                const studentIds = matchingStudents.map(s => s._id);
                const adminIds = matchingAdmins.map(a => a._id);
                const roundIds = matchingRounds.map(r => r._id);

                filter.$or = [
                    { student: { $in: studentIds } },
                    { conductedBy: { $in: adminIds } },
                    { round: { $in: roundIds } }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [attendance, total] = await Promise.all([
                Submission.find(filter)
                    .populate('student', 'studentId name')
                    .populate('conductedBy', 'name')
                    .populate('round', 'name')
                    .sort({ startTime: -1 })
                    .skip(skip)
                    .limit(limitNum),
                Submission.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.send({
                success: true,
                data: attendance,
                pagination: {
                    totalRecords: total,
                    totalPages,
                    currentPage: pageNum,
                    limit: limitNum
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch attendance' });
        }
    });

    /**
     * 1b. GET /api/superadmin/activity-logs
     * Returns platform activity logs (login, logout, create, update, delete, etc.)
     */
    fastify.get('/activity-logs', { preValidation: [fastify.requireSuperAdmin] }, async (request, reply) => {
        try {
            const { action, search, page = 1, limit = 20 } = request.query;

            const filter = {};
            if (action) filter.action = action;
            if (search) {
                const searchRegex = new RegExp(search, 'i');
                filter.$or = [
                    { 'performedBy.studentId': searchRegex },
                    { 'performedBy.name': searchRegex },
                    { 'target.type': searchRegex },
                    { 'target.label': searchRegex }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [logs, total] = await Promise.all([
                ActivityLog.find(filter)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum),
                ActivityLog.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: logs,
                pagination: {
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch activity logs' });
        }
    });

    /**
     * 2. GET /api/superadmin/rounds
     * Returns all rounds (for filter dropdown in audit logs and question manager).
     */
    fastify.get('/rounds', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const rounds = await Round.find({}).select('-startOtp -endOtp -otpIssuedAt').sort({ createdAt: 1 });
            return reply.code(200).send({ success: true, data: rounds });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch rounds' });
        }
    });

    /**
     * 2b. PATCH /api/superadmin/rounds/:roundId/question-settings
     * Update questionCount and shuffleQuestions for a round.
     * Clears previously assigned question sets so the new config takes effect.
     */
    fastify.patch('/rounds/:roundId/question-settings', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const { questionCount, shuffleQuestions } = request.body;

            const updateFields = {};
            if (questionCount !== undefined) updateFields.questionCount = questionCount === '' ? null : Number(questionCount) || null;
            if (shuffleQuestions !== undefined) updateFields.shuffleQuestions = Boolean(shuffleQuestions);

            const round = await Round.findByIdAndUpdate(roundId, updateFields, { new: true }).select('-startOtp -endOtp -otpIssuedAt');
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            // Clear previously assigned question sets so students get re-assigned on next load
            await Submission.updateMany({ round: roundId }, { $set: { assignedQuestions: [] } });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: `${round.name} question settings` },
                metadata: { questionCount: round.questionCount, shuffleQuestions: round.shuffleQuestions },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: round });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update question settings' });
        }
    });


    /**
     * 3. GET /api/superadmin/questions/:roundId
     * Returns all questions for a given round.
     */
    fastify.get('/questions/:roundId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const { search, page = 1, limit = 50 } = request.query;

            const filter = {
                $or: [
                    { round: roundId },
                    { linkedRounds: roundId }
                ]
            };
            if (search) {
                const searchRegex = new RegExp(search, 'i');
                const searchOr = [
                    { title: searchRegex },
                    { description: searchRegex },
                    { category: searchRegex }
                ];
                filter.$and = [
                    { $or: filter.$or },
                    { $or: searchOr }
                ];
                delete filter.$or;
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [questions, total] = await Promise.all([
                Question.find(filter)
                    .sort({ order: 1, createdAt: 1 })
                    .skip(skip)
                    .limit(limitNum),
                Question.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: questions,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch questions' });
        }
    });

    /**
     * 4. POST /api/superadmin/questions/:roundId
     * Create a new question for a round.
     */
    fastify.post('/questions/:roundId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const {
                title, description, inputFormat, outputFormat,
                sampleInput, sampleOutput, difficulty, points,
                order, type, category, options, correctAnswer,
                isManualEvaluation, assignedAdmin
            } = request.body;

            if (!title || !description) {
                return reply.code(400).send({ error: 'Title and description are required' });
            }

            if (isManualEvaluation && !assignedAdmin) {
                return reply.code(400).send({ error: 'A question marked for manual evaluation must be assigned to an admin' });
            }

            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            const question = new Question({
                round: roundId,
                title, description,
                inputFormat: inputFormat || '',
                outputFormat: outputFormat || '',
                sampleInput: sampleInput || '',
                sampleOutput: sampleOutput || '',
                difficulty: difficulty || 'MEDIUM',
                points: points || 10,
                order: order || 0,
                type: type || 'CODE',
                category: category || 'GENERAL',
                options: options || [],
                correctAnswer: correctAnswer || '',
                isManualEvaluation: isManualEvaluation || false,
                assignedAdmin: isManualEvaluation ? assignedAdmin : null
            });

            await question.save();

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question', id: question._id.toString(), label: question.title },
                metadata: { roundId },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data: question });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create question' });
        }
    });

    /**
     * 5. PUT /api/superadmin/questions/:questionId
     * Update an existing question.
     */
    fastify.put('/questions/:questionId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { questionId } = request.params;
            const updates = request.body;

            // If it's a bank question, we don't care about the round constraint.
            // But if it's not a bank question, it usually has a round. 
            // The frontend shouldn't pass `round` for a bank question anyway.
            if (updates.isManualEvaluation === false) {
                updates.assignedAdmin = null;
            }
            if (updates.isManualEvaluation === true && !updates.assignedAdmin) {
                return reply.code(400).send({ error: 'A question marked for manual evaluation must be assigned to an admin' });
            }

            const question = await Question.findByIdAndUpdate(questionId, updates, { new: true, runValidators: true });
            if (!question) return reply.code(404).send({ error: 'Question not found' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question', id: questionId, label: question.title },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: question });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update question' });
        }
    });

    /**
     * QUESTION BANK ROUTES
     */

    // 1. GET /api/superadmin/question-bank
    fastify.get('/question-bank', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, category, page = 1, limit = 50 } = request.query;

            const filter = { isBank: true };
            if (category) filter.category = category;

            if (search) {
                const searchRegex = new RegExp(search, 'i');
                filter.$or = [
                    { title: searchRegex },
                    { description: searchRegex },
                    { category: searchRegex }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [questions, total] = await Promise.all([
                Question.find(filter)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum),
                Question.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: questions,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch question bank' });
        }
    });

    // 2. POST /api/superadmin/question-bank
    fastify.post('/question-bank', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const {
                title, description, inputFormat, outputFormat,
                sampleInput, sampleOutput, difficulty, points,
                type, category, options, correctAnswer,
                isManualEvaluation, assignedAdmin
            } = request.body;

            if (!title || !description) {
                return reply.code(400).send({ error: 'Title and description are required' });
            }
            if (isManualEvaluation && !assignedAdmin) {
                return reply.code(400).send({ error: 'A question marked for manual evaluation must be assigned to an admin' });
            }

            const question = new Question({
                isBank: true,
                title, description,
                inputFormat: inputFormat || '',
                outputFormat: outputFormat || '',
                sampleInput: sampleInput || '',
                sampleOutput: sampleOutput || '',
                difficulty: difficulty || 'MEDIUM',
                points: points || 10,
                type: type || 'CODE',
                category: category || 'GENERAL',
                options: options || [],
                correctAnswer: correctAnswer || '',
                isManualEvaluation: isManualEvaluation || false,
                assignedAdmin: isManualEvaluation ? assignedAdmin : null
            });

            await question.save();

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question Bank', id: question._id.toString(), label: question.title },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data: question });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create bank question' });
        }
    });

    /**
     * POST /api/superadmin/bulk-upload-questions
     * Parses Excel, validates, and saves multiple questions to the library.
     */
    fastify.post('/bulk-upload-questions', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No spreadsheet file uploaded' });

            const buffer = await data.toBuffer();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(sheet);

            if (rows.length === 0) return reply.code(400).send({ error: 'Excel file is empty' });

            const validDifficulties = ['EASY', 'MEDIUM', 'HARD'];
            const validTypes = ['MCQ', 'CODE', 'DEBUG', 'FILL_BLANKS', 'EXPLAIN', 'UI_UX', 'MINI_HACKATHON'];
            const validCategories = ['SQL', 'HTML', 'CSS', 'UI_UX', 'GENERAL', 'MINI_HACKATHON'];

            const questionsToSave = [];
            let errorCount = 0;
            const errors = [];

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const lineNum = i + 2; // Assuming header is line 1

                const title = row.title || row.Title;
                const description = row.description || row.Description || row.Problem_Statement;

                if (!title || !description) {
                    errorCount++;
                    errors.push(`Row ${lineNum}: Title and Description are required.`);
                    continue;
                }

                const difficulty = (row.difficulty || row.Difficulty || 'MEDIUM').toUpperCase();
                const type = (row.type || row.Type || 'CODE').toUpperCase();
                const category = (row.category || row.Category || 'GENERAL').toUpperCase();
                const points = Number(row.points || row.Points) || 10;
                const isManualEvaluation = String(row.isManualEvaluation || row.Manual_Evaluation).toLowerCase() === 'true';

                if (!validDifficulties.includes(difficulty)) {
                    errorCount++;
                    errors.push(`Row ${lineNum}: Invalid difficulty "${difficulty}".`);
                    continue;
                }
                if (!validTypes.includes(type)) {
                    errorCount++;
                    errors.push(`Row ${lineNum}: Invalid type "${type}".`);
                    continue;
                }
                if (!validCategories.includes(category)) {
                    errorCount++;
                    errors.push(`Row ${lineNum}: Invalid category "${category}".`);
                    continue;
                }

                // Handle Options for MCQ
                let options = [];
                if (type === 'MCQ') {
                    if (row.options || row.Options) {
                        options = String(row.options || row.Options).split(',').map(o => o.trim());
                    } else {
                        for (let j = 1; j <= 10; j++) {
                            const opt = row[`Option ${j}`] || row[`option ${j}`] || row[`Option${j}`];
                            if (opt) options.push(String(opt).trim());
                        }
                    }
                    if (options.length < 2) {
                        errorCount++;
                        errors.push(`Row ${lineNum}: MCQ requires at least 2 options.`);
                        continue;
                    }
                }

                questionsToSave.push({
                    isBank: true,
                    title,
                    description,
                    inputFormat: row.inputFormat || row.Input_Format || '',
                    outputFormat: row.outputFormat || row.Output_Format || '',
                    sampleInput: row.sampleInput || row.Sample_Input || '',
                    sampleOutput: row.sampleOutput || row.Sample_Output || '',
                    difficulty,
                    points,
                    type,
                    category,
                    options,
                    correctAnswer: String(row.correctAnswer || row.Correct_Answer || ''),
                    isManualEvaluation
                });
            }

            if (questionsToSave.length === 0) {
                return reply.code(400).send({ error: 'No valid questions found in file.', details: errors });
            }

            const savedQuestions = await Question.insertMany(questionsToSave);

            await logActivity({
                action: 'BULK_UPLOAD',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question', label: `Bulk Upload: ${savedQuestions.length} Library items` },
                metadata: { successCount: savedQuestions.length, errorCount },
                ip: request.ip
            });

            return reply.code(201).send({
                success: true,
                message: `Successfully imported ${savedQuestions.length} questions.`,
                errorCount,
                errors: errors.length > 0 ? errors : undefined
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to process bulk upload', details: error.message });
        }
    });

    // 3. POST /api/superadmin/rounds/:roundId/import-from-bank
    fastify.post('/rounds/:roundId/import-from-bank', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const { questionIds } = request.body; // Array of Question Bank IDs

            if (!questionIds || !Array.isArray(questionIds) || questionIds.length === 0) {
                return reply.code(400).send({ error: 'Valid array of questionIds is required' });
            }

            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            // Fetch the questions to clone
            const bankQuestions = await Question.find({ _id: { $in: questionIds }, isBank: true });

            if (bankQuestions.length === 0) {
                return reply.code(404).send({ error: 'No valid bank questions found for the provided IDs' });
            }

            // Link them to the round (addToSet prevents duplicates)
            await Question.updateMany(
                { _id: { $in: bankQuestions.map(q => q._id) } },
                { $addToSet: { linkedRounds: roundId } }
            );

            await logActivity({
                action: 'IMPORTED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: `Imported ${bankQuestions.length} questions from Bank` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: `Successfully imported ${bankQuestions.length} questions.` });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to import questions from bank' });
        }
    });

    /**
     * GET /api/superadmin/manual-evaluations
     * Returns all submissions that have answers for questions assigned to this admin for manual evaluation.
     * Each entry contains: question info, student info, their answer, and existing manualScores.
     */
    fastify.get('/manual-evaluations', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const adminId = request.user.userId;
            const { page = 1, limit = 10, search = '' } = request.query;

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            // 1. Get all questions assigned to this admin for manual evaluation
            const adminQuestions = await Question.find({
                isManualEvaluation: true,
                assignedAdmin: adminId
            }).select('_id title description points type round category correctAnswer').lean();

            if (adminQuestions.length === 0) {
                return reply.code(200).send({
                    success: true,
                    data: [],
                    pagination: { totalRecords: 0, totalPages: 0, page: pageNum, limit: limitNum }
                });
            }

            const adminQuestionIds = adminQuestions.map(q => q._id);

            // 2. Build filter for Submissions
            // Only include submissions that have at least one question assigned to this admin 
            // where no entry exists in manualScores for that admin/question pair yet.
            const submissionFilter = {
                status: 'SUBMITTED',
                $and: [
                    { assignedQuestions: { $in: adminQuestionIds } },
                    {
                        $expr: {
                            $gt: [
                                {
                                    $size: {
                                        $filter: {
                                            input: adminQuestions,
                                            as: "q",
                                            cond: {
                                                $and: [
                                                    { $in: ["$$q._id", "$assignedQuestions"] },
                                                    {
                                                        $not: {
                                                            $in: ["$$q._id", {
                                                                $map: {
                                                                    input: "$manualScores",
                                                                    as: "ms",
                                                                    in: "$$ms.questionId"
                                                                }
                                                            }]
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                },
                                0
                            ]
                        }
                    }
                ]
            };


            if (search.trim()) {
                const students = await User.find({
                    role: 'STUDENT',
                    $or: [
                        { name: { $regex: search, $options: 'i' } },
                        { studentId: { $regex: search, $options: 'i' } }
                    ]
                }).select('_id');
                submissionFilter.student = { $in: students.map(s => s._id) };
            }

            // 3. Find and Paginate Submissions
            const [submissions, total] = await Promise.all([
                Submission.find(submissionFilter)
                    .populate('student', 'name studentId')
                    .populate('round', 'name')
                    .sort({ updatedAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .lean(),
                Submission.countDocuments(submissionFilter)
            ]);

            // 4. Transform results to show Student -> [Questions]
            const result = submissions.map(sub => {
                let answers = {};
                try {
                    answers = JSON.parse(sub.codeContent || '{}');
                } catch (e) {
                    answers = {};
                }

                const relevantQuestions = adminQuestions.filter(q =>
                    sub.assignedQuestions.some(aqId => aqId.toString() === q._id.toString())
                ).filter(q => {
                    // Only include questions that have NOT been graded yet
                    return !sub.manualScores?.some(ms => ms.questionId?.toString() === q._id.toString());
                }).map(q => {
                    return {
                        question: q,
                        answer: answers[q._id.toString()],
                        existingScore: null // Since we filtered for ungraded, there's no existing score
                    };
                });

                return {
                    submissionId: sub._id,
                    student: sub.student,
                    round: sub.round,
                    pdfUrl: sub.pdfUrl,
                    status: sub.status,
                    assignedQuestionsCount: sub.assignedQuestions.length,
                    questions: relevantQuestions
                };
            });

            return reply.code(200).send({
                success: true,
                data: result,
                pagination: {
                    totalRecords: total,
                    total: total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(total / limitNum)
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch manual evaluations' });
        }
    });

    /**
     * POST /api/superadmin/manual-evaluations/:submissionId/score
     * Admin submits or updates a manual score for a specific question in a student's submission.
     * Body: { questionId, score, feedback }
     */
    fastify.post('/manual-evaluations/:submissionId/score', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { submissionId } = request.params;
            const { questionId, score, feedback } = request.body;
            const adminId = request.user.userId;

            if (!questionId || score === undefined) {
                return reply.code(400).send({ error: 'questionId and score are required' });
            }

            // Verify the question is actually assigned to this admin
            const question = await Question.findOne({ _id: questionId, isManualEvaluation: true, assignedAdmin: adminId });
            if (!question) {
                return reply.code(403).send({ error: 'You are not authorized to evaluate this question' });
            }

            const submission = await Submission.findById(submissionId);
            if (!submission) return reply.code(404).send({ error: 'Submission not found' });

            // Upsert the manual score entry for this question
            const existingIndex = submission.manualScores.findIndex(
                ms => ms.questionId && ms.questionId.toString() === questionId.toString()
            );

            if (existingIndex >= 0) {
                submission.manualScores[existingIndex].score = score;
                submission.manualScores[existingIndex].feedback = feedback || '';
                submission.manualScores[existingIndex].evaluatedAt = new Date();
                submission.manualScores[existingIndex].adminId = adminId;
            } else {
                submission.manualScores.push({
                    questionId,
                    adminId,
                    score,
                    feedback: feedback || '',
                    evaluatedAt: new Date()
                });
            }

            // Recalculate total score as sum of all manual scores + autoScore
            const totalManualScore = submission.manualScores.reduce((sum, ms) => sum + (ms.score || 0), 0);

            // Fetch round to check if it's a team test
            const round = await Round.findById(submission.round);
            let finalScore = (submission.autoScore || 0) + totalManualScore;
            if (round && round.isTeamTest) {
                finalScore = finalScore / 2;
            }
            submission.score = finalScore;

            // NEW: Check if all manual questions for this round have been graded
            const manualQuestions = await Question.find({ round: submission.round, isManualEvaluation: true });
            const gradedQuestionIds = submission.manualScores.map(ms => ms.questionId?.toString());
            const allGraded = manualQuestions.every(q => gradedQuestionIds.includes(q._id.toString()));

            if (allGraded && submission.status === 'SUBMITTED') {
                submission.status = 'COMPLETED';
            }

            await submission.save();

            // RECALCULATE WINNERS for this round if certificates are released
            if (round && round.certificatesReleased) {
                // Clear existing winners first
                await Submission.updateMany({ round: submission.round }, { hasCertificate: false });

                // Find new top N
                // Include BOTH SUBMITTED and COMPLETED statuses
                const winners = await Submission.find({
                    round: submission.round,
                    status: { $in: ['SUBMITTED', 'COMPLETED'] }
                })
                    .sort({ score: -1 })
                    .limit(round.winnerLimit || 10)
                    .select('_id');

                const winnerIds = winners.map(w => w._id);
                if (winnerIds.length > 0) {
                    await Submission.updateMany(
                        { _id: { $in: winnerIds } },
                        { hasCertificate: true }
                    );
                }
            }

            // Invalidate ranking cache since scores have changed
            const { invalidateRankingCache } = require('../utils/eligibility');
            invalidateRankingCache();

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Submission', id: submissionId, label: `Manual score for question ${questionId}` },
                metadata: { questionId, score, feedback },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: { score: submission.score, manualScores: submission.manualScores } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to save evaluation score' });
        }
    });

    /**
     * GET /api/superadmin/student-scores
     * Returns per-student score summary: overall total, per-round scores, and day-wise breakdown.
     */
    fastify.get('/student-scores', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, page = 1, limit = 20 } = request.query;
            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            // 1. Build Match Stage
            const matchStage = {
                $or: [
                    { 'manualScores.0': { $exists: true } },
                    { score: { $ne: null } },
                    { autoScore: { $gt: 0 } }
                ]
            };

            // 2. Fetch Aggregated Data
            const pipeline = [
                { $match: matchStage },
                // Calculate score per submission
                {
                    $project: {
                        student: 1,
                        round: 1,
                        updatedAt: 1,
                        status: 1,
                        submissionScore: {
                            $add: [
                                { $ifNull: ["$autoScore", 0] },
                                {
                                    $reduce: {
                                        input: { $ifNull: ["$manualScores", []] },
                                        initialValue: 0,
                                        in: { $add: ["$$value", { $ifNull: ["$$this.score", 0] }] }
                                    }
                                }
                            ]
                        }
                    }
                },
                // Join Round name
                {
                    $lookup: {
                        from: 'rounds',
                        localField: 'round',
                        foreignField: '_id',
                        as: 'roundDetails'
                    }
                },
                { $unwind: { path: '$roundDetails', preserveNullAndEmptyArrays: true } },
                // Group by Student
                {
                    $group: {
                        _id: "$student",
                        totalScore: { $sum: "$submissionScore" },
                        rounds: {
                            $push: {
                                roundId: "$round",
                                roundName: { $ifNull: ["$roundDetails.name", "Unknown Round"] },
                                score: "$submissionScore",
                                status: "$status",
                                evaluatedAt: "$updatedAt"
                            }
                        }
                    }
                },
                // Join Student details
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'studentDetails'
                    }
                },
                { $unwind: '$studentDetails' },
                // Apply Search
                ...(search ? [{
                    $match: {
                        $or: [
                            { 'studentDetails.studentId': { $regex: search, $options: 'i' } },
                            { 'studentDetails.name': { $regex: search, $options: 'i' } }
                        ]
                    }
                }] : []),
                // Sort by total score
                { $sort: { totalScore: -1 } }
            ];

            // Get total count (for pagination)
            const countPipeline = [...pipeline, { $count: "total" }];
            const countResult = await Submission.aggregate(countPipeline);
            const total = countResult[0]?.total || 0;

            // Get paginated results
            const results = await Submission.aggregate([
                ...pipeline,
                { $skip: skip },
                { $limit: limitNum }
            ]);

            const paginatedData = results.map((r, index) => ({
                absoluteRank: skip + index + 1,
                student: {
                    _id: r._id,
                    studentId: r.studentDetails.studentId,
                    name: r.studentDetails.name
                },
                totalScore: r.totalScore,
                rounds: r.rounds,
                // Optional: add dummy dayWise if still needed by frontend (or refactor frontend)
                dayWise: []
            }));

            return reply.code(200).send({
                success: true,
                data: paginatedData,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(total / limitNum)
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch student scores' });
        }
    });

    /**
     * 6. DELETE /api/superadmin/questions/:questionId
     * Delete a question permanently.
     */
    fastify.delete('/questions/:questionId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { questionId } = request.params;
            const { roundId } = request.query;

            const question = await Question.findById(questionId);
            if (!question) return reply.code(404).send({ error: 'Question not found' });

            if (roundId && question.isBank) {
                // Just unlink from the round
                question.linkedRounds = question.linkedRounds.filter(rid => rid.toString() !== roundId);
                await question.save();

                await logActivity({
                    action: 'UNLINKED',
                    performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                    target: { type: 'Question', id: questionId, label: `Unlinked from round ${roundId}` },
                    ip: request.ip
                });

                return reply.code(200).send({ success: true, message: 'Question unlinked successfully' });
            }

            await Question.findByIdAndDelete(questionId);

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question', id: questionId, label: question.title },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Question deleted successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to delete question' });
        }
    });

    /**
     * ADMIN MANAGEMENT — all routes below are SUPER_ADMIN only
     */

    // GET /api/superadmin/admins — list all ADMIN users
    fastify.get('/admins', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, page = 1, limit = 20 } = request.query;

            const filter = { role: 'ADMIN' };
            if (search) {
                const searchRegex = new RegExp(search, 'i');
                filter.$or = [
                    { studentId: searchRegex },
                    { name: searchRegex }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [admins, total] = await Promise.all([
                User.find(filter)
                    .select('studentId name isBanned tokenIssuedAfter createdAt')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum),
                User.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: admins,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch admins' });
        }
    });

    // POST /api/superadmin/admins — create a new ADMIN
    fastify.post('/admins', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const bcrypt = require('bcryptjs');
            const { studentId, name, password } = request.body;
            if (!studentId || !name || !password) {
                return reply.code(400).send({ error: 'studentId, name, and password are required' });
            }
            const exists = await User.findOne({ studentId });
            if (exists) return reply.code(409).send({ error: 'User with this ID already exists' });

            const hashedPassword = await bcrypt.hash(password, 10);
            const admin = new User({ studentId, name, password: hashedPassword, role: 'ADMIN' });
            await admin.save();

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', id: admin._id.toString(), label: `${admin.studentId} (${admin.name})` },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data: { _id: admin._id, studentId: admin.studentId, name: admin.name } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create admin' });
        }
    });

    // DELETE /api/superadmin/admins/:adminId — remove an ADMIN permanently
    fastify.delete('/admins/:adminId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { adminId } = request.params;
            const admin = await User.findOneAndDelete({ _id: adminId, role: 'ADMIN' });
            if (!admin) return reply.code(404).send({ error: 'Admin not found' });

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', id: adminId, label: `${admin.studentId} (${admin.name})` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Admin removed successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to remove admin' });
        }
    });

    // PATCH /api/superadmin/admins/:adminId/block — toggle block/unblock an ADMIN
    fastify.patch('/admins/:adminId/block', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { adminId } = request.params;
            const admin = await User.findOne({ _id: adminId, role: 'ADMIN' });
            if (!admin) return reply.code(404).send({ error: 'Admin not found' });

            admin.isBanned = !admin.isBanned;
            // Force logout on block
            if (admin.isBanned) admin.tokenIssuedAfter = new Date();
            await admin.save();

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', id: adminId, label: `${admin.studentId} — ${admin.isBanned ? 'BLOCKED' : 'UNBLOCKED'}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, isBanned: admin.isBanned });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to toggle block status' });
        }
    });

    // PATCH /api/superadmin/admins/:adminId/force-logout — invalidate all existing sessions
    fastify.patch('/admins/:adminId/force-logout', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { adminId } = request.params;
            const admin = await User.findOneAndUpdate(
                { _id: adminId, role: 'ADMIN' },
                { tokenIssuedAfter: new Date() },
                { new: true }
            );
            if (!admin) return reply.code(404).send({ error: 'Admin not found' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', id: adminId, label: `${admin.studentId} — FORCE LOGOUT` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Admin has been force logged out' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to force logout admin' });
        }
    });

    // PATCH /api/superadmin/admins/:adminId/reset-password — set a new password for an admin
    fastify.patch('/admins/:adminId/reset-password', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const bcrypt = require('bcryptjs');
            const { adminId } = request.params;
            const { newPassword } = request.body;
            if (!newPassword || newPassword.length < 6) {
                return reply.code(400).send({ error: 'New password must be at least 6 characters' });
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            // Also force logout so the old password sessions die
            const admin = await User.findOneAndUpdate(
                { _id: adminId, role: 'ADMIN' },
                { password: hashedPassword, tokenIssuedAfter: new Date() },
                { new: true }
            );
            if (!admin) return reply.code(404).send({ error: 'Admin not found' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', id: adminId, label: `${admin.studentId} — PASSWORD RESET` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Password reset successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to reset password' });
        }
    });

    // GET /api/superadmin/admins/upload-template - DOWNLOAD SAMPLE EXCEL FOR ADMINS
    fastify.get('/admins/upload-template', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = [
                { 'AdminId': 'admin_01', 'Name': 'John Doe', 'Password': 'secretpassword' },
            ];
            const ws = XLSX.utils.json_to_sheet(data);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Admins');
            const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

            reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            reply.header('Content-Disposition', 'attachment; filename=admin_upload_template.xlsx');
            return reply.send(buffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate template' });
        }
    });

    // POST /api/superadmin/admins/upload - BULK CREATE ADMINS VIA EXCEL
    fastify.post('/admins/upload', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file uploaded' });

            const buffer = await data.toBuffer();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(sheet);

            if (json.length === 0) {
                return reply.code(400).send({ error: 'The uploaded file is empty' });
            }

            const bulkData = json.map(row => {
                const idKey = Object.keys(row).find(k =>
                    ['adminid', 'studentid', 'admin_id', 'username'].includes(k.toLowerCase().replace(/[\s_]/g, ''))
                );
                const nameKey = Object.keys(row).find(k => k.toLowerCase() === 'name');
                const passwordKey = Object.keys(row).find(k => k.toLowerCase() === 'password' || k.toLowerCase() === 'secret');

                if (!idKey) return null;

                return {
                    studentId: String(row[idKey]).trim(),
                    name: row[nameKey] ? String(row[nameKey]).trim() : null,
                    password: row[passwordKey] ? String(row[passwordKey]).trim() : '123456',
                    role: 'ADMIN'
                };
            }).filter(Boolean);

            if (bulkData.length === 0) {
                return reply.code(400).send({ error: 'No valid admin records found in Excel' });
            }

            let createdCount = 0;
            let skippedCount = 0;

            for (const item of bulkData) {
                const existing = await User.findOne({ studentId: item.studentId });
                if (existing) {
                    skippedCount++;
                } else {
                    const hashedPassword = await bcrypt.hash(item.password, 10);
                    await User.create({
                        ...item,
                        password: hashedPassword
                    });
                    createdCount++;
                }
            }

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Admin', label: `Bulk Upload: ${createdCount} created, ${skippedCount} skipped` },
                metadata: { createdCount, skippedCount },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: `Bulk creation complete. ${createdCount} admins created, ${skippedCount} skipped.`,
                data: { createdCount, skippedCount }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to process bulk upload' });
        }
    });

    /**
     * STUDENT MANAGEMENT — all routes below are SUPER_ADMIN only
     */

    // GET /api/superadmin/students — list all STUDENT users
    fastify.get('/students', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, page = 1, limit = 20 } = request.query;

            const filter = { role: 'STUDENT' };
            if (search) {
                const searchRegex = new RegExp(search, 'i');
                filter.$or = [
                    { studentId: searchRegex },
                    { name: searchRegex }
                ];
            }

            const pageNum = Math.max(1, Number(page));
            const limitNum = Math.max(1, Number(limit));
            const skip = (pageNum - 1) * limitNum;

            const [students, total] = await Promise.all([
                User.find(filter)
                    .select('studentId name email isBanned tokenIssuedAfter createdAt team linkedinProfile githubProfile phone bio isOnboarded dob')
                    .populate('team', 'name')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum),
                User.countDocuments(filter)
            ]);

            const totalPages = Math.ceil(total / limitNum);

            return reply.code(200).send({
                success: true,
                data: students,
                pagination: {
                    totalRecords: total,
                    total,
                    page: pageNum,
                    limit: limitNum,
                    totalPages
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch students' });
        }
    });

    // POST /api/superadmin/students — create a new STUDENT
    fastify.post('/students', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { studentId, email } = request.body;
            if (!studentId) {
                return reply.code(400).send({ error: 'studentId is required' });
            }
            const exists = await User.findOne({ studentId });
            if (exists) return reply.code(409).send({ error: 'User with this ID already exists' });

            const defaultPassword = '123456';
            const hashedPassword = await bcrypt.hash(defaultPassword, 10);
            const student = new User({
                studentId,
                name: `Student ${studentId}`,
                email: email || undefined,
                password: hashedPassword,
                role: 'STUDENT',
                isOnboarded: false
            });
            await student.save();

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: student._id.toString(), label: `${student.studentId}` },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data: { _id: student._id, studentId: student.studentId, name: student.name } });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create student' });
        }
    });

    // DELETE /api/superadmin/students/:studentId — remove a STUDENT permanently
    fastify.delete('/students/:studentId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { studentId } = request.params;
            const student = await User.findOneAndDelete({ _id: studentId, role: 'STUDENT' });
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            // Cascading delete: Remove all submissions for this student to maintain integrity
            await Submission.deleteMany({ student: studentId });

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: studentId, label: `${student.studentId} (${student.name})` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Student removed successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to remove student' });
        }
    });

    // PATCH /api/superadmin/students/:studentId/block — toggle block/unblock a STUDENT
    fastify.patch('/students/:studentId/block', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { studentId } = request.params;
            const student = await User.findOne({ _id: studentId, role: 'STUDENT' });
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            student.isBanned = !student.isBanned;

            if (student.isBanned) {
                student.tokenIssuedAfter = new Date(); // Invalidate current session
            } else {
                // Clear ban details when unblocking
                student.banReason = null;
                student.tokenIssuedAfter = null;
            }

            await student.save();

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: studentId, label: `${student.studentId} — ${student.isBanned ? 'BLOCKED' : 'UNBLOCKED'}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, isBanned: student.isBanned });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to toggle block status' });
        }
    });

    // GET /api/superadmin/students/:id/report — export student performance as PDF
    fastify.get('/students/:id/report', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { id } = request.params;
            const student = await User.findById(id).populate('team').lean();
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            const submissions = await Submission.find({ student: id })
                .populate('round')
                .sort({ 'round.createdAt': 1 })
                .lean();

            const pdfBuffer = await new Promise(async (resolve, reject) => {
                try {
                    const doc = new PDFDocument({ margin: 40, size: 'A4' });
                    let buffers = [];
                    doc.on('data', buffers.push.bind(buffers));
                    doc.on('end', () => resolve(Buffer.concat(buffers)));
                    doc.on('error', reject);

                    // --- Colors & Styles ---
                    const NAVY = '#1e293b';
                    const PURPLE = '#581c87';
                    const ACCENT = '#f59e0b'; // Amber/Yellow
                    const LIGHT_BLUE = '#eff6ff';

                    // --- Header Section ---
                    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
                    doc.text('TECHNOLOGY', { align: 'center' });
                    doc.moveDown(0.2);
                    doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
                    doc.moveDown(0.5);

                    // Yellow Bar
                    const pageWidth = doc.page.width;
                    const barWidth = 100;
                    doc.rect((pageWidth - barWidth) / 2, doc.y, barWidth, 3).fill(ACCENT);
                    doc.moveDown(0.8);

                    // Pill Shape for "C-CAP REPORT"
                    const pillWidth = 140;
                    const pillHeight = 24;
                    const pillX = (pageWidth - pillWidth) / 2;
                    doc.roundedRect(pillX, doc.y, pillWidth, pillHeight, 12).fill(NAVY);
                    doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('C-CAP REPORT', pillX, doc.y + 7, { width: pillWidth, align: 'center' });
                    doc.moveDown(1.5);

                    // Horizontal Divider
                    doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
                    doc.moveDown(0.2);
                    doc.moveTo(40, doc.y).lineTo(pageWidth - 40, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
                    doc.moveDown(1);

                    // Styled Title Box
                    const titleBoxY = doc.y;
                    doc.roundedRect(40, titleBoxY, pageWidth - 80, 45, 8).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();
                    doc.fillColor(NAVY).fontSize(18).text('STUDENT REPORT #1', 55, titleBoxY + 14);
                    doc.moveDown(2.5);

                    // --- 1. STUDENT PROFILE ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).text('1. STUDENT PROFILE', 50, doc.y);
                    doc.moveDown(0.8);

                    const profileY = doc.y;
                    const col1X = 60;
                    const col2X = pageWidth / 2 + 50; // Increased padding for center space

                    const drawField = (label, value, x, y, width) => {
                        doc.fillColor('#64748b').fontSize(10).text(label.toUpperCase(), x, y);
                        doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold').text(value || 'N/A', x + 90, y, { align: 'right', width: width || ((pageWidth / 3) - 100) });
                        doc.moveTo(x, y + 14).lineTo(x + (pageWidth / 2) - 30, y + 14).strokeColor('#f1f5f9').dash(2, { space: 2 }).stroke().undash();
                    };

                    const attendedCount = submissions.filter(s => s.status !== 'NOT_STARTED').length;

                    drawField('Full Name', student.name, col1X, profileY);
                    drawField('Roll Number', student.studentId, col2X, profileY);
                    drawField('Department', student.department, col1X, profileY + 35);
                    drawField('Current Level', `Level ${attendedCount}`, col2X, profileY + 35);

                    doc.moveDown(4);

                    // --- 2. ASSESSMENT SUMMARY ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('2. ASSESSMENT SUMMARY', 50, doc.y);
                    doc.moveDown(1);

                    if (submissions.length > 0) {
                        const assessmentRows = [];
                        for (const s of submissions) {
                            // Calculate Pass/Fail
                            const questions = await Question.find({
                                $or: [
                                    { round: s.round?._id },
                                    { linkedRounds: s.round?._id }
                                ]
                            });
                            const totalPoints = questions.reduce((acc, q) => acc + (q.points || 0), 0);
                            const qualified = (s.score >= totalPoints * 0.5);
                            const resultText = qualified ? 'QUALIFIED' : 'ELIMINATED';

                            assessmentRows.push([
                                new Date(s.createdAt).toLocaleDateString(),
                                s.round?.name || 'Round',
                                String(s.score ?? 0),
                                resultText
                            ]);
                        }

                        const assessmentTable = {
                            headers: [
                                { label: "Date", property: 'date', width: 100 },
                                { label: "Level", property: 'level', width: 220 },
                                { label: "Score", property: 'score', width: 80 },
                                { label: "Result", property: 'result', width: 100 }
                            ],
                            rows: assessmentRows
                        };

                        await doc.table(assessmentTable, {
                            prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY),
                            prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
                                doc.font("Helvetica").fontSize(10);
                                if (indexColumn === 3) { // Result Column
                                    if (row[3] === 'QUALIFIED') doc.fillColor('#16a34a');
                                    else doc.fillColor('#dc2626');
                                } else {
                                    doc.fillColor(NAVY);
                                }
                            }
                        });
                    } else {
                        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#94a3b8').text('No assessments found.');
                    }
                    doc.moveDown(2);

                    // --- 3. CODING CHALLENGE HISTORY ---
                    doc.fillColor(PURPLE).rect(40, doc.y, 4, 18).fill();
                    doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('3. CODING CHALLENGE HISTORY', 50, doc.y);
                    doc.moveDown(1);

                    // Fetch coding challenges
                    const codingSubmissions = submissions.filter(s => s.round?.type === 'CODE' || s.round?.type === 'SQL_CONTEST');
                    if (codingSubmissions.length > 0) {
                        // Similar table or list
                        doc.font('Helvetica').fontSize(10).fillColor(NAVY).text('Challenges attempted across contests: ' + codingSubmissions.length);
                    } else {
                        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#94a3b8').text('No coding challenges attempted.');
                    }

                    // --- Footer Decor ---
                    const footerY = doc.page.height - 60;
                    doc.rect(40, footerY, doc.page.width - 80, 6).fill(NAVY);

                    doc.end();
                } catch (err) {
                    reject(err);
                }
            });

            return reply
                .header('Content-Type', 'application/pdf')
                .header('Content-Disposition', `attachment; filename=Report_${student.studentId}.pdf`)
                .send(pdfBuffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate report' });
        }
    });
    // GET /api/superadmin/students/upload-template - DOWNLOAD SAMPLE EXCEL
    fastify.get('/students/upload-template', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = [
                { 'Roll No': '2024CS001' },
            ];
            const ws = XLSX.utils.json_to_sheet(data);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Students');
            const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

            reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            reply.header('Content-Disposition', 'attachment; filename=student_upload_template.xlsx');
            return reply.send(buffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate template' });
        }
    });

    // POST /api/superadmin/students/upload - BULK CREATE STUDENTS VIA EXCEL
    fastify.post('/students/upload', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file uploaded' });

            const buffer = await data.toBuffer();
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(sheet);

            if (json.length === 0) {
                return reply.code(400).send({ error: 'The uploaded file is empty' });
            }

            const bulkData = json.map(row => {
                const idKey = Object.keys(row).find(k =>
                    ['rollno', 'studentid', 'roll_no', 'roll number'].includes(k.toLowerCase().replace(/[\s_]/g, ''))
                );
                const nameKey = Object.keys(row).find(k => k.toLowerCase() === 'name');
                const emailKey = Object.keys(row).find(k => k.toLowerCase() === 'email');
                const phoneKey = Object.keys(row).find(k => k.toLowerCase() === 'phone');
                const dobKey = Object.keys(row).find(k => k.toLowerCase() === 'dob' || k.toLowerCase() === 'dateofbirth');
                const bioKey = Object.keys(row).find(k => k.toLowerCase() === 'bio');
                const linkedinKey = Object.keys(row).find(k => k.toLowerCase() === 'linkedin');
                const githubKey = Object.keys(row).find(k => k.toLowerCase() === 'github');

                if (!idKey) return null;

                const dobVal = row[dobKey] ? new Date(row[dobKey]) : null;

                return {
                    studentId: String(row[idKey]).trim(),
                    name: row[nameKey] ? String(row[nameKey]).trim() : null,
                    email: row[emailKey] ? String(row[emailKey]).trim() : null,
                    phone: row[phoneKey] ? String(row[phoneKey]).trim() : null,
                    dob: isNaN(dobVal) ? null : dobVal,
                    bio: row[bioKey] ? String(row[bioKey]).trim() : null,
                    linkedinProfile: row[linkedinKey] ? String(row[linkedinKey]).trim() : null,
                    githubProfile: row[githubKey] ? String(row[githubKey]).trim() : null,
                    role: 'STUDENT'
                };
            }).filter(Boolean);

            if (bulkData.length === 0) {
                return reply.code(400).send({ error: 'No valid student records found in Excel' });
            }

            let createdCount = 0;
            let skippedCount = 0;

            for (const item of bulkData) {
                const existing = await User.findOne({ studentId: item.studentId });
                if (existing) {
                    skippedCount++;
                } else {
                    await User.create({
                        ...item,
                        password: 'password_will_be_onboarded', // Students set during onboarding
                        isOnboarded: false
                    });
                    createdCount++;
                }
            }

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', label: `Bulk Upload: ${createdCount} created, ${skippedCount} skipped` },
                metadata: { createdCount, skippedCount },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: `Bulk creation complete. ${createdCount} students created, ${skippedCount} skipped.`,
                data: { createdCount, skippedCount }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to process bulk upload' });
        }
    });

    // GET /api/superadmin/admins/list - MINIMAL LIST FOR TRANSFERS
    fastify.get('/admins/list', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const admins = await User.find({ role: 'ADMIN', isBanned: false }).select('_id name studentId');
            return reply.code(200).send({ success: true, data: admins });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch admins list' });
        }
    });

    // PATCH /api/superadmin/manual-evaluations/transfer/:questionId - TRANSFER EVALUATION
    fastify.patch('/manual-evaluations/transfer/:questionId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { questionId } = request.params;
            const { newAdminId } = request.body;
            const currentAdminId = request.user.userId;

            if (!newAdminId) return reply.code(400).send({ error: 'newAdminId is required' });

            const question = await Question.findOne({ _id: questionId, isManualEvaluation: true, assignedAdmin: currentAdminId });
            if (!question) return reply.code(403).send({ error: 'You are not authorized to transfer this evaluation' });

            const newAdmin = await User.findOne({ _id: newAdminId, role: 'ADMIN', isBanned: false });
            if (!newAdmin) return reply.code(404).send({ error: 'Target admin not found or inactive' });

            question.assignedAdmin = newAdminId;
            await question.save();

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Question', id: questionId, label: `Transferred evaluation of "${question.title}" to ${newAdmin.name}` },
                metadata: { fromAdmin: currentAdminId, toAdmin: newAdminId },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Evaluation assignment transferred successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to transfer evaluation' });
        }
    });

    /**
     * DELETE /api/superadmin/submissions/:submissionId
     * Permanently deletes a student's submission record.
     */
    fastify.delete('/submissions/:submissionId', { preValidation: [fastify.requireSuperAdmin] }, async (request, reply) => {
        try {
            const { submissionId } = request.params;
            const submission = await Submission.findById(submissionId).populate('student', 'name studentId');
            if (!submission) return reply.code(404).send({ error: 'Submission not found' });

            await Submission.findByIdAndDelete(submissionId);

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Submission', id: submissionId, label: `Deleted submission for ${submission.student?.name} (${submission.student?.studentId})` },
                ip: request.ip
            });

            return reply.send({ success: true, message: 'Submission deleted successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to delete submission' });
        }
    });

    /**
     * PATCH /api/superadmin/submissions/:submissionId/extra-time
     * Grants additional time (in minutes) to a specific student's active submission.
     */
    fastify.patch('/submissions/:submissionId/extra-time', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { submissionId } = request.params;
            const { addMinutes } = request.body;

            if (addMinutes === undefined || isNaN(addMinutes) || Number(addMinutes) === 0) {
                return reply.code(400).send({ error: 'Valid minutes adjustment is required' });
            }

            const submission = await Submission.findById(submissionId).populate('student', 'name studentId');
            if (!submission) return reply.code(404).send({ error: 'Submission not found' });

            submission.extraTimeMinutes = (submission.extraTimeMinutes || 0) + Number(addMinutes);
            await submission.save();

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Submission', id: submissionId, label: `Granted +${addMinutes} mins extra time to ${submission.student?.name}` },
                metadata: { extraTimeMinutes: submission.extraTimeMinutes },
                ip: request.ip
            });

            return reply.send({ success: true, extraTimeMinutes: submission.extraTimeMinutes, message: `Added ${addMinutes} minutes successfully` });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to grant extra time' });
        }
    });

    /**
     * PATCH /api/superadmin/submissions/:submissionId/allow-reentry
     * Allows a student to re-enter a test they have already submitted or been disqualified from.
     */
    fastify.patch('/submissions/:submissionId/allow-reentry', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { submissionId } = request.params;
            const { addMinutes = 10 } = request.body || {}; // Default to 10 mins if not provided

            const submission = await Submission.findById(submissionId).populate('student', 'name studentId');
            if (!submission) return reply.code(404).send({ error: 'Submission not found' });

            if (submission.status !== 'SUBMITTED' && submission.status !== 'DISQUALIFIED') {
                return reply.code(400).send({ error: 'Re-entry can only be approved for submitted or disqualified tests' });
            }

            // Reset status so they can enter again
            submission.status = 'IN_PROGRESS';

            // Give them extra time so they can actually make changes
            submission.extraTimeMinutes = (submission.extraTimeMinutes || 0) + Number(addMinutes);

            // Clear disqualification reason
            submission.disqualificationReason = null;

            // CRITICAL: Also un-ban the student and restore session validity
            const student = await User.findById(submission.student);
            if (student) {
                student.isBanned = false;
                student.banReason = null;
                student.tokenIssuedAfter = null;
                await student.save();
            }

            await submission.save();

            // Log activity
            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Submission', id: submission._id, label: `Re-entry Approved for ${submission.student?.name}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: `Re-entry approved. Student granted ${addMinutes} extra minutes.` });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to approve re-entry' });
        }
    });

    // PATCH /api/superadmin/students/:studentId/force-logout — invalidate all sessions
    fastify.patch('/students/:studentId/force-logout', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { studentId } = request.params;
            const student = await User.findOneAndUpdate(
                { _id: studentId, role: 'STUDENT' },
                { tokenIssuedAfter: new Date() },
                { new: true }
            );
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            await logActivity({
                action: 'LOGOUT',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: studentId, label: `${student.studentId} — FORCE LOGOUT` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Student has been force logged out' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to force logout student' });
        }
    });

    // PATCH /api/superadmin/students/:studentId/reset-password — reset a student's password
    fastify.patch('/students/:studentId/reset-password', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const bcrypt = require('bcryptjs');
            const { studentId } = request.params;
            const { newPassword } = request.body;
            if (!newPassword || newPassword.length < 6) {
                return reply.code(400).send({ error: 'New password must be at least 6 characters' });
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            const student = await User.findOneAndUpdate(
                { _id: studentId, role: 'STUDENT' },
                { password: hashedPassword, tokenIssuedAfter: new Date() },
                { new: true }
            );
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: studentId, label: `${student.studentId} — PASSWORD RESET` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Password reset successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to reset password' });
        }
    });

    // PATCH /api/superadmin/students/:userId/team — assign a student to a team
    fastify.patch('/students/:userId/team', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { userId } = request.params;
            const { teamId } = request.body; // Can be null to unassign

            const student = await User.findById(userId);
            if (!student) return reply.code(404).send({ error: 'Student not found' });

            const oldTeamId = student.team;

            // 1. Update the Student
            student.team = teamId || null;
            await student.save();

            // 2. Update Team Memberships
            // Remove from old team
            if (oldTeamId) {
                const Team = require('../models/Team');
                await Team.findByIdAndUpdate(oldTeamId, { $pull: { members: userId } });
            }
            // Add to new team
            if (teamId) {
                const Team = require('../models/Team');
                await Team.findByIdAndUpdate(teamId, { $addToSet: { members: userId } });
            }

            const populatedStudent = await User.findById(userId).populate('team', 'name');

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Student', id: userId, label: `${student.studentId} — Team Update` },
                metadata: { oldTeamId, newTeamId: teamId },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: populatedStudent });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update student team' });
        }
    });

    /**
     * POST /api/superadmin/rounds/:roundId/generate-otp
     * Allows SuperAdmin to generate Start/End OTPs and unlock a round.
     */
    fastify.post('/rounds/:roundId/generate-otp', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const adminId = request.user.userId;
            const crypto = require('crypto');

            const startOtp = crypto.randomInt(100000, 999999).toString();
            const endOtp = crypto.randomInt(100000, 999999).toString();

            // Store in AdminOTP model (per admin)
            await AdminOTP.findOneAndUpdate(
                { adminId, roundId },
                { startOtp, endOtp, otpIssuedAt: new Date() },
                { upsert: true, new: true }
            );

            // Also update the round status to waiting if it's currently locked
            const round = await Round.findById(roundId);
            if (round && round.status === 'LOCKED') {
                round.status = 'WAITING_FOR_OTP';
                round.isOtpActive = true;
                await round.save();
            }

            await logActivity({
                action: 'OTP_GENERATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: round?.name || 'Round' },
                metadata: { adminId },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, startOtp, endOtp });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate OTPs' });
        }
    });

    /**
     * PATCH /api/superadmin/rounds/:roundId/status
     * Allows SuperAdmin to Force End a round, pause, etc.
     */
    fastify.patch('/rounds/:roundId/status', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        const { status, isOtpActive, durationMinutes, maxParticipants, startTime, endTime } = request.body;

        try {
            const updates = {};
            if (status) updates.status = status;
            if (isOtpActive !== undefined) updates.isOtpActive = isOtpActive;
            if (durationMinutes !== undefined) updates.durationMinutes = durationMinutes;
            if (maxParticipants !== undefined) updates.maxParticipants = maxParticipants;
            if (startTime !== undefined) updates.startTime = startTime;
            if (endTime !== undefined) updates.endTime = endTime;

            const round = await Round.findByIdAndUpdate(roundId, updates, { new: true }).select('-startOtp -endOtp -otpIssuedAt');
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: round.name },
                ip: request.ip
            });
            return reply.send({ success: true, data: round });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update round status' });
        }
    });

    /**
     * POST /api/superadmin/rounds/:roundId/allow-student
     * Add student to round whitelist
     */
    fastify.post('/rounds/:roundId/allow-student', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        const { studentId } = request.body; // Internal ObjectId

        try {
            const round = await Round.findByIdAndUpdate(
                roundId,
                { $addToSet: { allowedStudentIds: studentId } },
                { new: true }
            );
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            return reply.send({ success: true, data: round.allowedStudentIds });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to allow student' });
        }
    });

    /**
     * POST /api/superadmin/rounds/:roundId/disallow-student
     * Remove student from round whitelist
     */
    fastify.post('/rounds/:roundId/disallow-student', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        const { studentId } = request.body;

        try {
            const round = await Round.findByIdAndUpdate(
                roundId,
                { $pull: { allowedStudentIds: studentId } },
                { new: true }
            );
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            return reply.send({ success: true, data: round.allowedStudentIds });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to disallow student' });
        }
    });
    /**
     * DELETE /api/superadmin/rounds/:roundId
     * Deletes a round and its associated questions/submissions.
     */
    fastify.delete('/rounds/:roundId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { roundId } = request.params;
        try {
            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            // Delete associated questions and submissions to maintain integrity
            await Question.deleteMany({ round: roundId });
            await Submission.deleteMany({ round: roundId });

            await Round.findByIdAndDelete(roundId);

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: round.name },
                ip: request.ip
            });

            return reply.send({ success: true, message: 'Round and its data deleted successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to delete round' });
        }
    });

    /**
     * TEAM MANAGEMENT ROUTES
     */

    // 1. GET /api/superadmin/teams
    fastify.get('/teams', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const teams = await Team.find({}).populate('members', 'studentId name').sort({ name: 1 });
            return reply.code(200).send({ success: true, data: teams });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch teams' });
        }
    });

    // 2. POST /api/superadmin/teams
    fastify.post('/teams', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { name, members } = request.body;
        if (!name) return reply.code(400).send({ error: 'Team name is required' });

        try {
            const team = new Team({ name, members: members || [] });
            await team.save();

            if (members && members.length > 0) {
                await User.updateMany({ _id: { $in: members } }, { $set: { team: team._id } });
            }

            await logActivity({
                action: 'CREATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Team', id: team._id, label: team.name },
                ip: request.ip
            });

            return reply.code(201).send({ success: true, data: team });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to create team' });
        }
    });

    // 3. PUT /api/superadmin/teams/:teamId
    fastify.put('/teams/:teamId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { teamId } = request.params;
        const { name, members } = request.body;

        try {
            const oldTeam = await Team.findById(teamId);
            if (!oldTeam) return reply.code(404).send({ error: 'Team not found' });

            // Remove team ref from old members not in the new list
            const oldMembers = (oldTeam.members || []).map(m => m.toString());
            const newMembers = (members || []).map(m => m.toString());
            const removedMembers = oldMembers.filter(m => !newMembers.includes(m));

            if (removedMembers.length > 0) {
                await User.updateMany({ _id: { $in: removedMembers } }, { $set: { team: null } });
            }

            const team = await Team.findByIdAndUpdate(teamId, { name, members }, { new: true });

            if (members && members.length > 0) {
                await User.updateMany({ _id: { $in: members } }, { $set: { team: team._id } });
            }

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Team', id: teamId, label: team.name },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, data: team });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update team' });
        }
    });

    // 4. DELETE /api/superadmin/teams/:teamId
    fastify.delete('/teams/:teamId', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { teamId } = request.params;

        try {
            const team = await Team.findByIdAndDelete(teamId);
            if (!team) return reply.code(404).send({ error: 'Team not found' });

            // Clear team ref for all members
            await User.updateMany({ team: teamId }, { $set: { team: null } });

            await logActivity({
                action: 'DELETED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Team', id: teamId, label: team.name },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Team deleted' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to delete team' });
        }
    });

    // 5. GET /api/superadmin/team-scores
    fastify.get('/team-scores', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const teams = await Team.find({}).populate('members', '_id name studentId');
            const submissions = await Submission.find({ score: { $ne: null } }).lean();

            const teamScores = teams.map(team => {
                const memberIds = team.members.map(m => m._id.toString());
                const totalScore = submissions
                    .filter(sub => memberIds.includes(sub.student.toString()))
                    .reduce((sum, sub) => sum + (sub.score || 0), 0);

                return {
                    _id: team._id,
                    name: team.name,
                    members: team.members,
                    totalScore
                };
            }).sort((a, b) => b.totalScore - a.totalScore);

            return reply.code(200).send({ success: true, data: teamScores });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch team scores' });
        }

    });
    // 6. GET /api/superadmin/teams/:teamId/report
    fastify.get('/teams/:teamId/report', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        const { teamId } = request.params;

        try {
            const team = await Team.findById(teamId).populate('members', 'name studentId phone email department');
            if (!team) return reply.code(404).send({ error: 'Team not found' });

            // Fetch all teams to calculate rank
            const allTeams = await Team.find({}).lean();
            const allSubmissions = await Submission.find({ score: { $ne: null } }).lean();

            const scores = allTeams.map(t => {
                const teamSubmissions = allSubmissions.filter(s =>
                    t.members.some(mId => mId.toString() === s.student.toString())
                );
                return {
                    id: t._id.toString(),
                    totalScore: teamSubmissions.reduce((sum, s) => sum + (s.score || 0), 0)
                };
            }).sort((a, b) => b.totalScore - a.totalScore);

            const rank = scores.findIndex(s => s.id === teamId) + 1;
            const teamTotalScore = scores.find(s => s.id === teamId)?.totalScore || 0;

            // Fetch individual scores for team members
            const memberStats = await Promise.all(team.members.map(async (m) => {
                const memberSubmissions = allSubmissions.filter(s => s.student.toString() === m._id.toString());
                const totalScore = memberSubmissions.reduce((sum, s) => sum + (s.score || 0), 0);
                const attended = memberSubmissions.filter(s => s.status !== 'NOT_STARTED').length;
                return {
                    name: m.name,
                    studentId: m.studentId,
                    attended,
                    score: totalScore
                };
            }));

            const pdfBuffer = await new Promise(async (resolve, reject) => {
                try {
                    const doc = new PDFDocument({ margin: 40, size: 'A4' });
                    let buffers = [];
                    doc.on('data', buffers.push.bind(buffers));
                    doc.on('end', () => resolve(Buffer.concat(buffers)));
                    doc.on('error', reject);

                    // Styles
                    const NAVY = '#1e293b';
                    const PURPLE = '#581c87';
                    const ACCENT = '#f59e0b';
                    const LIGHT_BLUE = '#eff6ff';

                    // Header
                    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('BANNARI AMMAN INSTITUTE OF', { align: 'center' });
                    doc.text('TECHNOLOGY', { align: 'center' });
                    doc.moveDown(0.2);
                    doc.fontSize(16).fillColor(PURPLE).text('CODE CIRCLE CLUB', { align: 'center' });
                    doc.moveDown(0.5);
                    const pageWidth = doc.page.width;
                    doc.rect((pageWidth - 100) / 2, doc.y, 100, 3).fill(ACCENT);
                    doc.moveDown(0.8);
                    const chipWidth = 180; // Increased from 160 for padding
                    const chipHeight = 24;
                    const chipX = (pageWidth - chipWidth) / 2;
                    doc.roundedRect(chipX, doc.y, chipWidth, chipHeight, 12).fill(NAVY);
                    doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text('TEAM PERFORMANCE REPORT', chipX, doc.y + 7, { width: chipWidth, align: 'center' });
                    doc.moveDown(2);

                    // Team Info Box
                    const infoY = doc.y;
                    doc.roundedRect(40, infoY, pageWidth - 80, 70, 10).fill(LIGHT_BLUE).strokeColor('#e2e8f0').stroke();

                    doc.fillColor(NAVY).fontSize(18).font('Helvetica-Bold').text(team.name.toUpperCase(), 60, infoY + 15);
                    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`RANK #${rank} OVERALL`, 60, infoY + 38);

                    doc.fillColor(PURPLE).fontSize(24).font('Helvetica-Bold').text(String(teamTotalScore), pageWidth - 200, infoY + 15, { width: 140, align: 'right' });
                    doc.fontSize(10).font('Helvetica-Bold').fillColor(PURPLE).text('AGGREGATE POINTS', pageWidth - 200, infoY + 42, { width: 140, align: 'right' });

                    doc.moveDown(4);

                    // 1. SQUAD OVERVIEW
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
                            String(m.attended),
                            String(m.score)
                        ])
                    };

                    await doc.table(table, {
                        prepareHeader: () => doc.font("Helvetica-Bold").fontSize(10).fillColor(NAVY),
                        prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
                            doc.font("Helvetica").fontSize(10).fillColor(NAVY);
                            if (indexRow % 2 === 0) doc.addBackground(rectRow, LIGHT_BLUE, 0.4);
                        }
                    });

                    // Footer
                    const footerY = doc.page.height - 60;
                    doc.rect(40, footerY, doc.page.width - 80, 6).fill(NAVY);

                    doc.end();
                } catch (err) {
                    reject(err);
                }
            });

            reply.type('application/pdf').header('Content-Disposition', `attachment; filename=Team_Report_${team.name}.pdf`).send(pdfBuffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate team report' });
        }
    });

    /**
     * CERTIFICATE MANAGEMENT
     */

    // 1. POST /api/superadmin/certificates/template - UPLOAD TEMPLATE
    fastify.post('/certificates/template', { preValidation: [fastify.requireSuperAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file uploaded' });

            const uploadsDir = path.join(__dirname, '../uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

            const filePath = path.join(uploadsDir, 'certificate_template' + path.extname(data.filename));

            // Remove existing templates to avoid confusion
            const files = fs.readdirSync(uploadsDir);
            for (const file of files) {
                if (file.startsWith('certificate_template')) {
                    fs.unlinkSync(path.join(uploadsDir, file));
                }
            }

            const buffer = await data.toBuffer();
            fs.writeFileSync(filePath, buffer);

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Certificate', label: 'Updated Background Template' },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Template uploaded successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to upload template' });
        }
    });

    // 2. GET /api/superadmin/rounds/:roundId/certificate-template - GET ROUND TEMPLATE PREVIEW
    fastify.get('/rounds/:roundId/certificate-template', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const round = await Round.findById(roundId);
            if (!round || !round.certificateTemplate) return reply.code(404).send({ error: 'No template found for this round' });


           const filePath = path.join(uploadsDir, round.certificateTemplate);

            if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'Template file missing on server' });

            const buffer = fs.readFileSync(filePath);
            reply.type('application/pdf'); // It's a PDF now
            return reply.send(buffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch template' });
        }
    });

    // Legacy Global Preview (Optional, can keep for backward compatibility or remove)
    fastify.get('/certificates/template', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const uploadsDir = path.join(__dirname, '../uploads');

            const files = fs.readdirSync(uploadsDir);
            const templateFile = files.find(f => f.startsWith('certificate_template'));

            if (!templateFile) return reply.code(404).send({ error: 'No template found' });

            const buffer = fs.readFileSync(path.join(uploadsDir, templateFile));
             reply.type('application/pdf');
            return reply.send(buffer);
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch template' });
        }
    });

    // 3. GET /api/superadmin/certificates/generate - GENERATE BULK PDF ZIP
    fastify.get('/certificates/generate', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId, limit = 10 } = request.query;
            if (!roundId) return reply.code(400).send({ error: 'roundId is required' });

            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            const uploadsDir = path.join(__dirname, '../uploads');
            const templateFile = round.certificateTemplate;

            if (!templateFile) return reply.code(400).send({ error: 'Please upload a certificate template for this round first' });
            const templatePath = path.join(uploadsDir, templateFile);

            if (!fs.existsSync(templatePath)) return reply.code(500).send({ error: 'Template file missing on server' });

            // Fetch top winners
            const submissions = await Submission.find({ round: roundId, status: 'SUBMITTED' })
                .sort({ score: -1 })
                .limit(Number(limit))
                .populate('student', 'name studentId');

            if (submissions.length === 0) return reply.code(404).send({ error: 'No submissions found for this round' });

            const zip = new JSZip();

            for (const sub of submissions) {
                const studentName = sub.student?.name || 'Student';

                // Create PDF using PDFKit
                const doc = new PDFDocument({
                    layout: 'landscape',
                    size: 'A4',
                    margin: 0
                });

                // Buffer to collect PDF data
                const chunks = [];
                doc.on('data', chunk => chunks.push(chunk));

                // Add template background
                doc.image(templatePath, 0, 0, { width: doc.page.width, height: doc.page.height });

                // Add Student Name - Centered vertically and horizontally (Customizable in future)
                doc.font('Helvetica-Bold').fontSize(40).fillColor('#1e293b');

                // Draw text in middle
                const textWidth = doc.widthOfString(studentName);
                const x = (doc.page.width - textWidth) / 2;
                const y = doc.page.height / 2.2;

                doc.text(studentName, x, y);

                doc.end();

                // Wait for PDF to finish
                const pdfBuffer = await new Promise((resolve) => {
                    doc.on('end', () => resolve(Buffer.concat(chunks)));
                });

                zip.file(`${sub.student?.studentId || 'unknown'}_certificate.pdf`, pdfBuffer);
            }

            const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

            reply.header('Content-Type', 'application/zip');
            reply.header('Content-Disposition', `attachment; filename=${round.name.replace(/\s+/g, '_')}_certificates.zip`);
            return reply.send(zipBuffer);

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate certificates' });
        }
    });

    // 4. PATCH /api/superadmin/rounds/:roundId/release-certificates - TOGGLE RELEASE
    fastify.patch('/rounds/:roundId/release-certificates', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { roundId } = request.params;
            const { released, limit } = request.body;

            const round = await Round.findById(roundId);
            if (!round) return reply.code(404).send({ error: 'Round not found' });

            round.certificatesReleased = released !== undefined ? released : !round.certificatesReleased;
            if (limit !== undefined) round.winnerLimit = limit;

            await round.save();

            // Update hasCertificate flags for all submissions in this round
            // Clear all flags first
            await Submission.updateMany({ round: roundId }, { hasCertificate: false });

            if (round.certificatesReleased) {
                // Find Top N winners
                const winners = await Submission.find({
                    round: roundId,
                    status: { $in: ['SUBMITTED', 'COMPLETED'] }
                })
                    .sort({ score: -1 })
                    .limit(round.winnerLimit || 10)
                    .select('_id');

                const winnerIds = winners.map(w => w._id);
                if (winnerIds.length > 0) {
                    await Submission.updateMany(
                        { _id: { $in: winnerIds } },
                        { hasCertificate: true }
                    );
                }
            }

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: request.user?.userId, name: request.user?.name, role: request.user?.role },
                target: { type: 'Round', id: roundId, label: `Certificates ${round.certificatesReleased ? 'RELEASED' : 'REVOKED'}` },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                message: `Certificates ${round.certificatesReleased ? 'released' : 'revoked'} successfully`,
                data: { certificatesReleased: round.certificatesReleased, winnerLimit: round.winnerLimit }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update certificate release status' });
        }
    });


    /**
     * GET /api/superadmin/team-requests
     * Returns all students who have a pending team enrollment request.
     */
    fastify.get('/team-requests', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const requests = await User.find({
                'teamRequest.status': 'PENDING',
                team: null,
                role: 'STUDENT'
            }).select('studentId name email department teamRequest createdAt').sort({ 'teamRequest.requestedAt': 1 });

            return reply.code(200).send({ success: true, data: requests });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch team requests' });
        }
    });

    /**
     * POST /api/superadmin/team-requests/:userId/assign
     * Admin assigns the student to a team — approves their request.
     * Body: { teamId: string }
     */
    fastify.post('/team-requests/:userId/assign', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { userId } = request.params;
            const { teamId } = request.body;

            if (!teamId) return reply.code(400).send({ error: 'teamId is required' });

            const [user, team] = await Promise.all([
                User.findById(userId),
                Team.findById(teamId)
            ]);

            if (!user) return reply.code(404).send({ error: 'User not found' });
            if (!team) return reply.code(404).send({ error: 'Team not found' });

            // Assign team on user document
            user.team = team._id;
            user.teamRequest = { status: 'APPROVED', message: null, requestedAt: user.teamRequest?.requestedAt };
            await user.save();

            // Add member to team (if not already)
            if (!team.members.includes(user._id)) {
                team.members.push(user._id);
                await team.save();
            }

            await logActivity({
                action: 'TEAM_ASSIGNED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'User', id: userId, label: `${user.studentId} assigned to team ${team.name}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: `${user.studentId} assigned to team "${team.name}".` });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to assign team' });
        }
    });

    /**
     * POST /api/superadmin/team-requests/:userId/reject
     * Admin rejects the student's team enrollment request.
     * Body: { message?: string }
     */
    fastify.post('/team-requests/:userId/reject', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { userId } = request.params;
            const { message } = request.body || {};

            const user = await User.findById(userId);
            if (!user) return reply.code(404).send({ error: 'User not found' });

            user.teamRequest = {
                status: 'REJECTED',
                message: message || 'Your request was rejected by the admin.',
                requestedAt: user.teamRequest?.requestedAt
            };
            await user.save();

            await logActivity({
                action: 'TEAM_REQUEST_REJECTED',
                performedBy: { userId: request.user?.userId, studentId: request.user?.studentId, name: request.user?.name, role: request.user?.role },
                target: { type: 'User', id: userId, label: `${user.studentId} — Team request rejected` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Request rejected.' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to reject team request' });
        }
    });


};
