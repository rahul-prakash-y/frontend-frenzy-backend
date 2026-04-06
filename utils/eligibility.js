const Submission = require('../models/Submission');
const Round = require('../models/Round');

// In-memory cache for rankings to prevent DB bottleneck during high concurrency
let rankingCache = {
    data: null, // Array of { id, totalScore, rank }
    lastFetched: 0,
    TTL: 60 * 1000 // 1 minute TTL
};

/**
 * Calculates student rank based on total score across the platform using MongoDB Aggregation.
 */
async function getStudentRank(studentObjectId) {
    const now = Date.now();

    // Check cache
    if (rankingCache.data && (now - rankingCache.lastFetched < rankingCache.TTL)) {
        const found = rankingCache.data.find(s => s.id === studentObjectId.toString());
        return found ? found.rank : rankingCache.data.length + 1;
    }

    // Pipeline to sum scores per student
    const pipeline = [
        {
            $match: {
                $or: [
                    { 'manualScores.0': { $exists: true } },
                    { score: { $ne: null } },
                    { autoScore: { $gt: 0 } }
                ]
            }
        },
        {
            $project: {
                student: 1,
                submissionScore: {
                    $add: [
                        { $ifNull: ["$autoScore", 0] },
                        {
                            $reduce: {
                                input: { $ifNull: ["$manualScores", []] },
                                initialValue: 0,
                                in: { $add: ["$$value", { $ifNull: ["$$this.score", 0] }] }
                            }
                        }
                    ]
                }
            }
        },
        {
            $group: {
                _id: "$student",
                totalScore: { $sum: "$submissionScore" }
            }
        },
        {
            $sort: { totalScore: -1 }
        }
    ];

    const results = await Submission.aggregate(pipeline);

    // Map with rank
    const rankedResults = results.map((r, index) => ({
        id: r._id ? r._id.toString() : 'unknown',
        totalScore: r.totalScore,
        rank: index + 1
    }));

    // Update Cache
    rankingCache.data = rankedResults;
    rankingCache.lastFetched = now;

    const found = rankedResults.find(s => s.id === studentObjectId.toString());
    return found ? found.rank : rankedResults.length + 1;
}

/**
 * Force clear the ranking cache (e.g. after manual grading)
 */
function invalidateRankingCache() {
    rankingCache.data = null;
    rankingCache.lastFetched = 0;
}

/**
 * Checks if a student is eligible for a specific round.
 */
async function isStudentEligible(studentObjectId, roundId, roundObject = null) {
    const round = roundObject || await Round.findById(roundId);
    if (!round) return { eligible: false, message: 'Round not found' };

    // 1. If no limit is set, everyone is eligible
    if (round.maxParticipants === null || round.maxParticipants === undefined) {
        return { eligible: true };
    }

    // 2. Check if student is manually whitelisted
    // Ensure string comparison for ObjectIds
    if (round.allowedStudentIds && round.allowedStudentIds.some(id => id.toString() === studentObjectId.toString())) {
        return { eligible: true, reason: 'ADMIN_ALLOWED' };
    }

    // 3. Check Rank
    const rank = await getStudentRank(studentObjectId);
    if (rank <= round.maxParticipants) {
        return { eligible: true, rank };
    }

    return {
        eligible: false,
        rank,
        maxRank: round.maxParticipants,
        message: `Eligibility restricted to top ${round.maxParticipants} students. Your current rank is #${rank}.`
    };
}

module.exports = {
    getStudentRank,
    isStudentEligible,
    invalidateRankingCache
};
