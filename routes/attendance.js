const AttendanceOTP = require('../models/AttendanceOTP');
const Attendance = require('../models/Attendance');
const { logActivity } = require('../utils/logger');

module.exports = async function (fastify, opts) {

    // ─── ADMIN: Generate Attendance OTP ──────────────────────────────────────
    fastify.post('/generate', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const adminId = request.user.userId;
            const { roundId } = request.body || {};

            if (!roundId) {
                return reply.code(400).send({ error: 'Round ID is required to generate attendance OTP for a specific round' });
            }

            // Random 6-digit OTP
            const otp = Math.floor(100000 + Math.random() * 900000).toString();

            // OTP valid for 1 minute
            const expiresAt = new Date(Date.now() + 1 * 60 * 1000);

            // Deactivate any existing OTPs for this admin (for this round if specified, else all)
            const deactivateFilter = { adminId, isActive: true };
            if (roundId) deactivateFilter.roundId = roundId;
            await AttendanceOTP.updateMany(deactivateFilter, { isActive: false });

            const newOtp = new AttendanceOTP({
                adminId,
                otp,
                expiresAt,
                roundId: roundId || null
            });

            await newOtp.save();

            return reply.send({
                success: true,
                data: {
                    otp,
                    expiresAt,
                    secondsLeft: 60,
                    roundId: roundId || null
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to generate attendance OTP' });
        }
    });

    // ─── ADMIN: Get Active OTP ────────────────────────────────────────────────
    fastify.get('/active', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const adminId = request.user.userId;
            const { roundId } = request.query;

            const filter = {
                adminId,
                isActive: true,
                expiresAt: { $gt: new Date() }
            };
            if (roundId) filter.roundId = roundId;

            const activeOtp = await AttendanceOTP.findOne(filter);

            if (!activeOtp) {
                return reply.send({ success: false, message: 'No active OTP found' });
            }

            const secondsLeft = Math.max(0, Math.ceil((new Date(activeOtp.expiresAt) - new Date()) / 1000));

            return reply.send({
                success: true,
                data: {
                    otp: activeOtp.otp,
                    expiresAt: activeOtp.expiresAt,
                    secondsLeft,
                    roundId: activeOtp.roundId || null
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch active OTP' });
        }
    });

    // ─── STUDENT: Mark Attendance ─────────────────────────────────────────────
    fastify.post('/mark', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { otp } = request.body;
            const studentId = request.user.userId;

            if (!otp) return reply.code(400).send({ error: 'OTP is required' });

            // Find an active OTP that matches
            const activeOtp = await AttendanceOTP.findOne({
                otp,
                isActive: true,
                expiresAt: { $gt: new Date() }
            });

            if (!activeOtp) {
                return reply.code(400).send({ error: 'Invalid or expired OTP' });
            }

            // Create attendance record; carry over roundId from the OTP if present
            const attendance = new Attendance({
                student: studentId,
                markedBy: activeOtp.adminId,
                round: activeOtp.roundId || null
            });

            await attendance.save();

            await logActivity({
                action: 'ATTENDANCE_MARKED',
                performedBy: { userId: request.user.userId, studentId: request.user.studentId, name: request.user.name, role: request.user.role },
                target: { type: 'Attendance', id: attendance._id.toString(), label: `Marked by ${activeOtp.adminId}${activeOtp.roundId ? ` for round ${activeOtp.roundId}` : ''}` },
                ip: request.ip
            });

            return reply.send({
                success: true,
                message: 'Attendance marked successfully'
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to mark attendance' });
        }
    });

    // ─── ADMIN/SUPERADMIN: Get Attendance List ──────────────────────────────
    fastify.get('/records', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { search, page = 1, limit = 20 } = request.query;
            let filter = {};

            // Search logic (optional but good)
            const attendance = await Attendance.find(filter)
                .populate('student', 'name studentId')
                .populate('markedBy', 'name')
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit);

            const total = await Attendance.countDocuments(filter);

            return reply.send({
                success: true,
                data: attendance,
                pagination: {
                    totalRecords: total,
                    totalPages: Math.ceil(total / limit),
                    currentPage: Number(page)
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch attendance records' });
        }
    });

    // ─── ADMIN: Delete Attendance Record ─────────────────────────────────────
    fastify.delete('/:id', { preValidation: [fastify.requireAdmin] }, async (request, reply) => {
        try {
            const { id } = request.params;

            const attendance = await Attendance.findById(id);
            if (!attendance) {
                return reply.code(404).send({ error: 'Attendance record not found' });
            }

            // Optional: Only allow the admin who marked it or a SuperAdmin to delete it
            // if (request.user.role !== 'SUPERADMIN' && attendance.markedBy.toString() !== request.user.userId) {
            //     return reply.code(403).send({ error: 'Unauthorized to delete this record' });
            // }

            await Attendance.findByIdAndDelete(id);

            await logActivity({
                action: 'ATTENDANCE_REMOVED',
                performedBy: { userId: request.user.userId, studentId: request.user.studentId, name: request.user.name, role: request.user.role },
                target: { type: 'Attendance', id: id, label: `Removed record for student ${attendance.student}` },
                ip: request.ip
            });

            return reply.send({
                success: true,
                message: 'Attendance record removed successfully'
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to delete attendance record' });
        }
    });
};
