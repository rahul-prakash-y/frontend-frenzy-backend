const mongoose = require('mongoose');

const adminOTPSchema = new mongoose.Schema({
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    roundId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        required: true
    },
    testGroupId: {
        type: String, // String ID used for grouping rounds
        default: null
    },
    startOtp: {
        type: String,
        length: 6,
        required: true
    },
    endOtp: {
        type: String,
        length: 6,
        required: true
    },
    otpIssuedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for efficient lookup and to manage rotating OTPs
adminOTPSchema.index({ adminId: 1, roundId: 1 });
adminOTPSchema.index({ adminId: 1, testGroupId: 1 });

module.exports = mongoose.model('AdminOTP', adminOTPSchema);
