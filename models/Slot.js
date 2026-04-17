const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
    round: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Round',
        required: true
    },
    label: {
        type: String,
        required: true,
        trim: true
    },
    startTime: {
        type: Date,
        required: true
    },
    endTime: {
        type: Date,
        required: true
    },
    teams: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team'
    }],
    maxCapacity: {
        type: Number,
        default: null
    }
}, {
    timestamps: true
});

slotSchema.index({ round: 1 });

module.exports = mongoose.model('Slot', slotSchema);
