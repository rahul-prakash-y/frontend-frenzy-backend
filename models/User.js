const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  studentId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    required: true,
    // Note: should be hashed before saving
  },
  email: {
    type: String,
    required: false,
    trim: true,
    index: true
  },
  role: {
    type: String,
    enum: ['STUDENT', 'ADMIN', 'SUPER_ADMIN'],
    default: 'STUDENT'
  },
  name: {
    type: String,
    required: false,
    default: 'Student'
  },
  isOnboarded: {
    type: Boolean,
    default: false
  },
  registeredRoundIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Round'
  }],
  // Track anti-cheat flags globally across the platform
  isBanned: {
    type: Boolean,
    default: false
  },
  banReason: {
    type: String
  },
  // Force logout support: any token issued before this timestamp is rejected
  tokenIssuedAfter: {
    type: Date,
    default: null
  },
  team: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    default: null
  },
  linkedinProfile: {
    type: String,
    trim: true,
    default: null
  },
  githubProfile: {
    type: String,
    trim: true,
    default: null
  },
  phone: {
    type: String,
    trim: true,
    default: null
  },
  bio: {
    type: String,
    trim: true,
    default: null
  },
  dob: {
    type: Date,
    default: null
  },
  department: {
    type: String,
    trim: true,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);
