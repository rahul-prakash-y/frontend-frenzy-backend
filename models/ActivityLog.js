const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
    action: {
        type: String,
        required: true,
        enum: ['LOGIN', 'LOGOUT', 'CREATED', 'UPDATED', 'DELETED', 'BULK_UPLOAD', 'OTP_GENERATED', 'ROUND_STARTED', 'ROUND_SUBMITTED', 'DISQUALIFIED', 'CHEAT_DETECTED']
    },
    performedBy: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        studentId: { type: String },
        name: { type: String },
        role: { type: String }
    },
    target: {
        type: { type: String }, // e.g. 'User', 'Round', 'Question', 'Submission'
        id: { type: String },
        label: { type: String } // human-readable, e.g. student name or round name
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed, // extra context (IP, changes, etc.)
        default: {}
    },
    ip: { type: String, default: null }
}, {
    timestamps: true
});

// Index for fast querying by action and date
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ 'performedBy.userId': 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
