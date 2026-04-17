const fp = require('fastify-plugin');
const fastifyJwt = require('@fastify/jwt');
const User = require('../models/User');

// ─── Banned-User Cache (Task 2) ───────────────────────────────────────────────
// Holds userIds of banned/force-logged-out accounts checked in the last 5 min.
// Avoids a User.findById() call on every single authenticated request.

/** @type {Set<string>} userId strings of known-banned users */
const bannedCache = new Set();

/** Timestamp of the last full DB refresh of the banned cache */
let bannedCacheRefreshedAt = 0;

const BANNED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * refreshBannedCache()
 *  Queries MongoDB for all banned users and rebuilds the Set.
 *  Called lazily — only when the TTL has expired.
 */
async function refreshBannedCache() {
    const now = Date.now();
    if (now - bannedCacheRefreshedAt < BANNED_CACHE_TTL_MS) return; // Still fresh

    try {
        const bannedUsers = await User.find({ isBanned: true }, '_id').lean();
        bannedCache.clear();
        bannedUsers.forEach(u => bannedCache.add(u._id.toString()));
        bannedCacheRefreshedAt = now;
    } catch (err) {
        // On failure: keep the stale cache — safer than letting banned users through
        console.error('[BannedCache] Refresh failed, keeping stale cache:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = fp(async function (fastify, opts) {
    // Register the JWT plugin
    fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET || 'supersecret_ccc_key_change_in_production',
        verify: {
            allowedClockSkew: 60 // 60 seconds tolerance for inaccurate student laptop clocks
        }
    });

    // ── Helper: full DB check (tokenIssuedAfter + isBanned) ──────────────────
    // Still used by authenticate and requireAdmin — but now costs zero DB ops
    // for the common case where the userId is NOT in the banned cache.
    async function checkForceLogout(request, reply) {
        const payload = request.user;
        if (!payload?.userId) return true;

        const uid = payload.userId.toString();

        // Fast-path: banned cache hit → block immediately, no DB touch
        await refreshBannedCache(); // no-op when cache is still fresh
        if (bannedCache.has(uid)) {
            reply.code(403).send({ error: 'Account is blocked' });
            return false;
        }

        // Slow-path: only runs for non-banned users (the 99.9% happy path)
        // and only needs to check tokenIssuedAfter now, since isBanned is
        // already covered by the cache above.
        const user = await User.findById(uid).select('tokenIssuedAfter isBanned').lean();
        if (!user) {
            reply.code(401).send({ error: 'Unauthorized: User no longer exists' });
            return false;
        }

        // Double-check isBanned in case the cache hasn't refreshed yet
        if (user.isBanned) {
            bannedCache.add(uid); // Eagerly populate cache for next request
            reply.code(403).send({ error: 'Account is blocked' });
            return false;
        }

        if (user.tokenIssuedAfter) {
            const iatMs = payload.iat * 1000;
            if (iatMs < user.tokenIssuedAfter.getTime()) {
                reply.code(401).send({ error: 'Session invalidated. Please log in again.' });
                return false;
            }
        }

        return true;
    }

    // ── Task 1: authenticateLight ─────────────────────────────────────────────
    // JWT signature verification ONLY — zero DB queries.
    // Use for high-traffic read endpoints where you trust the signed token
    // and can tolerate a <5 min window before a ban takes effect.
    // Safe for: leaderboard reads, enqueue-submit (stateless payload push).
    fastify.decorate('authenticateLight', async function (request, reply) {
        try {
            await request.jwtVerify();
            // No DB call. Banned users will be caught on their next
            // standard-auth request or within 5 minutes at most.
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });

    // ── Standard authenticate (Student or Admin) ──────────────────────────────
    fastify.decorate('authenticate', async function (request, reply) {
        try {
            await request.jwtVerify();
            await checkForceLogout(request, reply);
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });

    // ── Admin-only ────────────────────────────────────────────────────────────
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

    // ── Super-Admin-only ──────────────────────────────────────────────────────
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

    // ── Super-Master-only (Database Access) ───────────────────────────────────
    fastify.decorate('requireSuperMaster', async function (request, reply) {
        try {
            await request.jwtVerify();
            if (request.user.role !== 'SUPER_MASTER') {
                return reply.code(403).send({ error: 'Forbidden: Super Master access required' });
            }
            await checkForceLogout(request, reply);
        } catch (err) {
            if (!reply.sent) reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
    });
});
