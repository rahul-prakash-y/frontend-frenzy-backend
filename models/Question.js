const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
    round: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        // Optional because Question Bank questions don't belong to a round
        index: true
    },
    isBank: {
        type: Boolean,
        default: false,
        index: true
    },
    linkedRounds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round'
    }],
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    inputFormat: {
        type: String,
        default: ''
    },
    outputFormat: {
        type: String,
        default: ''
    },
    sampleInput: {
        type: String,
        default: ''
    },
    sampleOutput: {
        type: String,
        default: ''
    },
    difficulty: {
        type: String,
        enum: ['EASY', 'MEDIUM', 'HARD'],
        default: 'MEDIUM'
    },
    points: {
        type: Number,
        default: 10
    },
    order: {
        type: Number,
        default: 0
    },
    type: {
        type: String,
        enum: ['MCQ', 'CODE', 'DEBUG', 'FILL_BLANKS', 'EXPLAIN', 'UI_UX', 'MINI_HACKATHON'],
        default: 'CODE'
    },
    category: {
        type: String,
        enum: ['SQL', 'HTML', 'CSS', 'UI_UX', 'GENERAL', 'MINI_HACKATHON'],
        default: 'GENERAL'
    },
    options: {
        type: [String], // For MCQs
        default: []
    },
    correctAnswer: {
        type: String, // For automated grading (MCQs, etc)
        default: ''
    },
    isManualEvaluation: {
        type: Boolean,
        default: false
    },
    assignedAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Question', questionSchema);
