const mongoose = require('mongoose');

const roundSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String
    },
    startOtp: {
        type: String,
        length: 6,
        default: null // Generated live by admin
    },
    endOtp: {
        type: String,
        length: 6,
        default: null // Generated live by admin
    },
    otpIssuedAt: {
        type: Date,
        default: null // Tracks when OTP was last generated for 1-min rotation
    },
    durationMinutes: {
        type: Number,
        required: true,
        default: 60 // 1 hour continuous timer
    },
    status: {
        type: String,
        enum: ['LOCKED', 'WAITING_FOR_OTP', 'RUNNING', 'COMPLETED'],
        default: 'LOCKED'
    },
    // Allows admins to globally turn on/off OTP entry for the round
    isOtpActive: {
        type: Boolean,
        default: false
    },
    type: {
        type: String,
        enum: ['SQL_CONTEST', 'HTML_CSS_QUIZ', 'UI_UX_CHALLENGE', 'HTML_CSS_DEBUG', 'MINI_HACKATHON', 'GENERAL'],
        default: 'GENERAL'
    },
    // Global test sequence grouping
    testGroupId: {
        type: String,
        default: null // null if standalone round
    },
    testDurationMinutes: {
        type: Number,
        default: null // overriding duration shared across the test group
    },
    roundOrder: {
        type: Number,
        default: 1 // execution order within the test group
    },
    // Question pool settings
    questionCount: {
        type: Number,
        default: null // null = all questions; set to N to give each student N random questions
    },
    shuffleQuestions: {
        type: Boolean,
        default: true // When true, each student gets questions in a different order
    },
    isTeamTest: {
        type: Boolean,
        default: false // If true, scores are halved for individual students
    },
    // Eligibility & Participation Limits
    maxParticipants: {
        type: Number,
        default: null // null = no limit (open to all)
    },
    allowedStudentIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    certificatesReleased: {
        type: Boolean,
        default: false
    },
    winnerLimit: {
        type: Number,
        default: 10
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Round', roundSchema);
