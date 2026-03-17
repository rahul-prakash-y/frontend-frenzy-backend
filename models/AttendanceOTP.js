const mongoose = require('mongoose');

const attendanceOTPSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    roundId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        default: null
    },
    otp: {
        type: String,
        required: true,
        length: 6
    },
    expiresAt: {
        type: Date,
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Auto-expire documents after they reach expiresAt
attendanceOTPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AttendanceOTP', attendanceOTPSchema);
