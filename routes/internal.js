'use strict';

const { hydrateStaticData } = require('../services/cacheService');

module.exports = async function (fastify, opts) {
    /**
     * POST /api/internal/sync-cache
     * Internal endpoint to trigger RAM cache refresh across multiple instances.
     * Auth: Shared Secret Key (Bearer Token)
     */
    fastify.post('/sync-cache', async (request, reply) => {
        const sharedSecret = process.env.SHARED_SECRET_KEY;
        const authHeader = request.headers.authorization;

        // 1. Authentication Check
        if (!sharedSecret) {
            fastify.log.error('[InternalSync] SHARED_SECRET_KEY is not defined in .env');
            return reply.code(500).send({ 
                success: false, 
                error: 'Server configuration error: missing sync key' 
            });
        }

        if (authHeader !== `Bearer ${sharedSecret}`) {
            fastify.log.warn(`[InternalSync] Unauthorized sync attempt from IP: ${request.ip}`);
            return reply.code(401).send({ 
                success: false, 
                error: 'Unauthorized: Invalid Sync Token' 
            });
        }

        // 2. Hydration Trigger
        try {
            fastify.log.info('[InternalSync] Received valid sync trigger. Refreshing RAM cache...');
            
            // Re-fetch all Rounds and Questions from MongoDB into RAM
            await hydrateStaticData();

            return reply.code(200).send({ 
                success: true, 
                message: 'RAM Cache Synced Successfully', 
                timestamp: new Date().toISOString() 
            });
        } catch (error) {
            fastify.log.error(`[InternalSync] Cache hydration failed: ${error.message}`);
            return reply.code(500).send({ 
                success: false, 
                error: `Cache hydration failed: ${error.message}` 
            });
        }
    });
};
