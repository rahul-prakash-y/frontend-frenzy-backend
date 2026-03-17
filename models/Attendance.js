const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    markedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    round: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        default: null
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Ensure a student is only marked once per day (optional, but good for data integrity)
// Actually, let's keep it simple for now as they might have multiple sessions.
// attendanceSchema.index({ student: 1, createdAt: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
