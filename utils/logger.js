const ActivityLog = require('../models/ActivityLog');

/**
 * Logs a platform activity event.
 * @param {Object} opts
 * @param {string} opts.action - The event type (LOGIN, LOGOUT, CREATED, etc.)
 * @param {Object} opts.performedBy - { userId, studentId, name, role }
 * @param {Object} [opts.target] - { type, id, label }
 * @param {Object} [opts.metadata] - Any extra context
 * @param {string} [opts.ip] - IP address of the request
 */
async function logActivity({ action, performedBy, target = {}, metadata = {}, ip = null }) {
    try {
        await ActivityLog.create({ action, performedBy, target, metadata, ip });
    } catch (err) {
        // Never let audit logging crash the main request
        console.error('[ActivityLog] Failed to write log:', err.message);
    }
}

module.exports = { logActivity };
