const mongoose = require('mongoose');

const practiceSubmissionSchema = new mongoose.Schema({
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
    status: {
        type: String,
        enum: ['IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'DISQUALIFIED'],
        default: 'IN_PROGRESS'
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    completedAt: {
        type: Date,
        default: null
    },
    codeContent: {
        type: String,
        default: ''
    },
    pdfUrl: {
        type: String,
        default: null
    },
    score: {
        type: Number,
        default: null
    },
    autoScore: {
        type: Number,
        default: 0
    },
    // Manual evaluation scores per question (same as Submission)
    manualScores: [
        {
            questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
            adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            score: { type: Number, default: 0 },
            rubricScores: [{
                criterion: { type: String, required: true },
                score: { type: Number, required: true }
            }],
            feedback: { type: String, default: '' },
            evaluatedAt: { type: Date, default: Date.now }
        }
    ],
    // Shuffled question IDs assigned to this student
    assignedQuestions: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Question' }
    ]
}, {
    timestamps: true
});

// We want to track every attempt (up to limit), so no unique index
practiceSubmissionSchema.index({ student: 1, round: 1 });

module.exports = mongoose.model('PracticeSubmission', practiceSubmissionSchema);
