const mongoose = require('mongoose');

const practiceAttemptSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    round: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        required: true
    },
    attemptCount: {
        type: Number,
        default: 1
    }
}, {
    timestamps: true
});

// Ensure a student has only one practice attempt record per round, which we increment
practiceAttemptSchema.index({ student: 1, round: 1 }, { unique: true });

module.exports = mongoose.model('PracticeAttempt', practiceAttemptSchema);
