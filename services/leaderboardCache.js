/**
 * leaderboardCache.js
 * --------------------
 * Task 1: In-Memory Leaderboard Cache
 *
 * Strategy:
 *  - A background setInterval recalculates the global leaderboard from
 *    MongoDB every 60 seconds and stores the result in a plain JS variable.
 *  - The API endpoint reads ONLY from this variable → O(1) read, zero DB hit
 *    during traffic spikes.
 *  - If the cache is still warm from a previous cycle, callers are never
 *    blocked even if MongoDB is temporarily slow.
 */

'use strict';

const Submission = require('../models/Submission');

// ─── In-Memory Store ─────────────────────────────────────────────────────────

/**
 * leaderboardCache
 *  An array of rank entries sorted by score (desc).
 *  Shape: [{ rank, studentId, name, department, score, roundId }, …]
 */
let leaderboardCache = [];

/** Timestamp of the last successful refresh (ISO string). */
let lastUpdatedAt = null;

/** Whether a refresh is currently in progress (prevents overlapping queries). */
let isRefreshing = false;

// ─── Cache Refresh Logic ──────────────────────────────────────────────────────

/**
 * refreshLeaderboard
 *  Queries MongoDB for all submitted/graded submissions, computes ranks,
 *  and atomically replaces the in-memory cache.
 *
 *  Called once at startup and then every REFRESH_INTERVAL_MS.
 */
async function refreshLeaderboard() {
    if (isRefreshing) {
        // Previous cycle is still running (slow DB). Skip this tick.
        return;
    }

    isRefreshing = true;

    try {
        // Aggregate: group by student, sum their scores across all rounds,
        // populate basic student info, sort descending.
        const results = await Submission.aggregate([
            {
                // Only count submissions that have been scored
                $match: {
                    status: 'SUBMITTED',
                    score: { $ne: null }
                }
            },
            {
                $group: {
                    _id: '$student',
                    totalScore: { $sum: '$score' },
                    roundsAttempted: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'studentInfo'
                }
            },
            { $unwind: '$studentInfo' },
            {
                $project: {
                    _id: 0,
                    studentId: '$studentInfo.studentId',
                    name: '$studentInfo.name',
                    department: '$studentInfo.department',
                    totalScore: 1,
                    roundsAttempted: 1
                }
            },
            { $sort: { totalScore: -1, name: 1 } }  // Alphabetical tiebreak
        ]).allowDiskUse(false); // Enforce in-memory aggregation (M0 safety)

        // Assign dense ranks
        const ranked = results.map((entry, index) => ({
            rank: index + 1,
            ...entry
        }));

        // Atomic swap — reads always see a consistent snapshot
        leaderboardCache = ranked;
        lastUpdatedAt = new Date().toISOString();

    } catch (err) {
        // Log but DO NOT crash — stale cache is better than hard failure
        console.error('[LeaderboardCache] Refresh failed:', err.message);
    } finally {
        isRefreshing = false;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getLeaderboard()
 *  Returns the cached leaderboard array. O(1) — no DB touch.
 */
function getLeaderboard() {
    return leaderboardCache;
}

/**
 * getCacheMetadata()
 *  Useful for a /health endpoint or admin diagnostics.
 */
function getCacheMetadata() {
    return {
        totalEntries: leaderboardCache.length,
        lastUpdatedAt,
        isRefreshing
    };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * startLeaderboardCache()
 *  Call once at server startup (after DB connection is established).
 *  Fires an immediate refresh so the cache is warm before the first request.
 */
function startLeaderboardCache() {
    console.info('[LeaderboardCache] Starting background refresh service…');

    // Warm the cache immediately on boot
    refreshLeaderboard();

    // Schedule subsequent refreshes
    setInterval(refreshLeaderboard, REFRESH_INTERVAL_MS);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    startLeaderboardCache,
    getLeaderboard,
    getCacheMetadata
};
