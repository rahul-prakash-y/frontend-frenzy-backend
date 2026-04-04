'use strict';

const Round = require('../models/Round');
const Question = require('../models/Question');

let globalRoundsCache = [];
let globalQuestionsCache = {};

/**
 * Hydrates the static data arrays (Rounds and Questions) from MongoDB to RAM.
 * Called securely at boot time to prevent high DB read connections from students.
 */
async function hydrateStaticData() {
    try {
        console.info('[CacheService] Hydrating static data to RAM...');

        // Cache all rounds, stripping sensitive OTP information
        globalRoundsCache = await Round.find({})
            .select('-startOtp -endOtp -otpIssuedAt')
            .sort({ createdAt: -1 })
            .lean();

        // Fetch all questions from the DB
        const questions = await Question.find({}).lean();
        
        globalQuestionsCache = {};

        // Map questions strictly to their rounds, removing the answers for memory safety
        questions.forEach(q => {
            // Strip correctAnswer to protect memory and prevent sending to clients
            delete q.correctAnswer;
            
            // Map by primary round
            if (q.round) {
                const rId = q.round.toString();
                if (!globalQuestionsCache[rId]) {
                    globalQuestionsCache[rId] = [];
                }
                globalQuestionsCache[rId].push(q);
            }

            // Map by linkedRounds
            if (q.linkedRounds && q.linkedRounds.length > 0) {
                q.linkedRounds.forEach(rIdObj => {
                    const rId = rIdObj.toString();
                    if (!globalQuestionsCache[rId]) {
                        globalQuestionsCache[rId] = [];
                    }
                    globalQuestionsCache[rId].push(q);
                });
            }
        });
        
        // Deduplicate in case a question was mapped twice to the same round
        for (const [rId, qs] of Object.entries(globalQuestionsCache)) {
            const uniqueQsMap = new Map();
            qs.forEach(q => uniqueQsMap.set(q._id.toString(), q));
            globalQuestionsCache[rId] = Array.from(uniqueQsMap.values()).sort((a,b) => a.order - b.order);
        }

        console.info(`[CacheService] Hydration complete. Cached ${globalRoundsCache.length} rounds. Questions cached in RAM.`);
    } catch (error) {
        console.error('[CacheService] Error hydrating static data:', error.message);
    }
}

function getRoundsCache() {
    return globalRoundsCache;
}

function getQuestionsByRound(roundId) {
    return globalQuestionsCache[roundId.toString()] || [];
}

module.exports = {
    hydrateStaticData,
    getRoundsCache,
    getQuestionsByRound
};
