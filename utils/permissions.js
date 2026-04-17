const Round = require('../models/Round');

/**
 * Checks if a user (Admin) has permission to manage a specific round.
 * SuperAdmins have permission to everything.
 * Admins must be in the round's authorizedAdmins list.
 * 
 * @param {Object} user - The user object from request.user
 * @param {String} roundId - The ID of the round to check
 * @returns {Boolean} - True if authorized, False otherwise
 */
async function checkRoundPermission(user, roundId) {
    if (!user || (!user.userId && !user.id)) return false;
    
    // Super Admins bypass all round-based restrictions
    if (user.role === 'SUPER_ADMIN' || user.role === 'SUPER_MASTER') return true;
    
    // Standard Admins must be explicitly authorized for this round OR it must be a PRACTICE round
    if (user.role === 'ADMIN') {
        const round = await Round.findById(roundId).select('authorizedAdmins type');
        if (!round) return false;
        
        // Practice rounds are open to all admins for oversight
        if (round.type === 'PRACTICE') return true;
        
        const userId = user.userId || user.id;
        return round.authorizedAdmins && round.authorizedAdmins.some(adminId => adminId.toString() === userId.toString());
    }
    
    return false;
}

module.exports = {
    checkRoundPermission
};
