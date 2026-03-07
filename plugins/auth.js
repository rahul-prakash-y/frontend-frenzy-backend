const fp = require('fastify-plugin');
const fastifyJwt = require('@fastify/jwt');
const User = require('../models/User');

/**
 * Fastify Auth Plugin Configuration
 * This maps exactly how Fastify secures endpoints for our platform.
 */
module.exports = fp(async function (fastify, opts) {
    // Register the JWT plugin
    fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET || 'supersecret_ccc_key_change_in_production'
    });

    // Helper: check tokenIssuedAfter to honour force logout
    async function checkForceLogout(request, reply) {
        const payload = request.user;
        if (!payload?.userId) return;
        const user = await User.findById(payload.userId).select('tokenIssuedAfter isBanned');
        if (!user) {
            reply.code(401).send({ error: 'Unauthorized: User no longer exists' });
            return false;
        }
        if (user.isBanned) {
            reply.code(403).send({ error: 'Account is blocked' });
            return false;
        }
        if (user.tokenIssuedAfter) {
            // JWT iat is in seconds, tokenIssuedAfter is a Date (ms)
            const iatMs = payload.iat * 1000;
            if (iatMs < user.tokenIssuedAfter.getTime()) {
                reply.code(401).send({ error: 'Session invalidated. Please log in again.' });
                return false;
            }
        }
        return true;
    }

    // Decorator to verify STANDARD authentication (Student or Admin)
    fastify.decorate('authenticate', async function (request, reply) {
        try {
            await request.jwtVerify();
            await checkForceLogout(request, reply);
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });

    // Decorator to verify ADMIN ONLY access
    fastify.decorate('requireAdmin', async function (request, reply) {
        try {
            await request.jwtVerify();
            if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
                return reply.code(403).send({ error: 'Forbidden: Admin access required' });
            }
            await checkForceLogout(request, reply);
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });

    // Decorator to verify SUPER_ADMIN ONLY access
    fastify.decorate('requireSuperAdmin', async function (request, reply) {
        try {
            await request.jwtVerify();
            if (request.user.role !== 'SUPER_ADMIN') {
                return reply.code(403).send({ error: 'Forbidden: Super Admin access required' });
            }
            await checkForceLogout(request, reply);
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });
});

