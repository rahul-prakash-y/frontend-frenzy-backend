const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
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
    // Track status per student for this round
    status: {
        type: String,
        enum: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'DISQUALIFIED', 'COMPLETED'],
        default: 'NOT_STARTED'
    },
    startTime: {
        type: Date,
        default: null
    },
    endTime: {
        type: Date,
        default: null
    },
    // Code answers, can be JSON stringified based on round type
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
        default: null // Graded later (Total score: autoScore + manualScores)
    },
    autoScore: {
        type: Number,
        default: 0 // Auto-evaluated score for MCQs
    },
    // Time extension granted by Admin/SuperAdmin for this student
    extraTimeMinutes: {
        type: Number,
        default: 0
    },

    // Anti-Cheat tracking
    cheatFlags: {
        type: Number,
        default: 0
    },
    tabSwitches: {
        type: Number,
        default: 0
    },
    forceExited: {
        type: Boolean,
        default: false
    },
    disqualificationReason: {
        type: String,
        default: null
    },
    // Manual evaluation scores per question
    manualScores: [
        {
            questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
            adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            score: { type: Number, default: 0 },
            feedback: { type: String, default: '' },
            evaluatedAt: { type: Date, default: Date.now }
        }
    ],
    // Shuffled question IDs assigned to this student for this round
    assignedQuestions: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Question' }
    ],
    // The admin whose OTP was used to start the test
    conductedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    hasCertificate: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

// Ensure a student can only have one submission per round
submissionSchema.index({ student: 1, round: 1 }, { unique: true });

module.exports = mongoose.model('Submission', submissionSchema);
