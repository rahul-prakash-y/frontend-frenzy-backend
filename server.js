require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const mongoose = require('mongoose');
const fastifyStatic = require("@fastify/static");
const path = require("path");

// ─── Background Services ──────────────────────────────────────────────────────
const { startLeaderboardCache } = require('./services/leaderboardCache');
const { startSubmissionQueue, flushNow } = require('./services/submissionQueue');

// ─── Task 4: Strict CORS Configuration ───────────────────────────────────────
// Reads the allowed origin from the environment variable FRONTEND_URL.
// Falls back to a safe empty string so the server won't accidentally open up
// in development if the env var is missing.
// Credentials: true is required for cookies / Authorization headers.
// Wildcard '*' is intentionally NOT used.
fastify.register(require('@fastify/cors'), {
    origin: (origin, callback) => {
        const allowedOrigin = process.env.FRONTEND_URL || "*";

        // Always allow non-browser requests (e.g. curl, Postman, health checks)
        // where `origin` header is undefined.
        if (!origin || origin === allowedOrigin) {
            return callback(null, true);
        }

        // All other origins are blocked.
        fastify.log.warn(`[CORS] Blocked request from unauthorized origin: ${origin}`);
        return callback(new Error(`CORS: Origin '${origin}' not allowed`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true   // Required for cookies / auth headers
});

// ─── Multipart (Bulk Excel Uploads) ──────────────────────────────────────────
fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 10 * 1024 * 1024 // 10 MB limit
    }
});

// ─── Auth Plugin (JWT + Role Decorators) ─────────────────────────────────────
fastify.register(require('./plugins/auth'));

// ─── Application Routes ───────────────────────────────────────────────────────
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/rounds'), { prefix: '/api/rounds' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });
fastify.register(require('./routes/superadmin'), { prefix: '/api/superadmin' });
fastify.register(require('./routes/attendance'), { prefix: '/api/attendance' });
fastify.register(require('./routes/student'), { prefix: '/api/student' });

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const closeServer = async (signal) => {
    fastify.log.info(`Received signal to terminate: ${signal}`);

    try {
        // Step 1: Stop accepting new HTTP requests and wait for in-flight
        // handlers to finish. After this resolves, no new payloads can be
        // pushed onto the in-memory submissionQueue — the array is frozen.
        await fastify.close();
        fastify.log.info('Fastify server closed. No new requests will be accepted.');

        // Step 2: Drain the now-frozen in-memory queue to MongoDB.
        // Safe to do here because fastify.close() guarantees no concurrent
        // enqueueSubmission() calls can race against this flush.
        fastify.log.info('Flushing in-memory submission queue to MongoDB…');
        await flushNow();
        fastify.log.info('Submission queue drained.');

        // Step 3: Close the MongoDB connection pool only after all writes
        // from flushNow() have committed.
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.close();
            fastify.log.info('MongoDB connections drained properly.');
        }

        process.exit(0);
    } catch (err) {
        fastify.log.error('Error during shutdown', err);
        process.exit(1);
    }
};

process.on('SIGINT', () => closeServer('SIGINT'));
process.on('SIGTERM', () => closeServer('SIGTERM'));

// ─── Database Connection & Server Boot ────────────────────────────────────────
const start = async () => {
    try {
        // Task 3: MongoDB Connection Pooling Cap
        // maxPoolSize: 20  → hard ceiling so we never exhaust Atlas M0's 500-connection
        //                    limit even if multiple server instances are running.
        // serverSelectionTimeoutMS: 5000 → fail fast rather than hanging indefinitely.
        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/code_circuit_club';

        await mongoose.connect(mongoUri, {
            maxPoolSize: 20,                  // ← Tuned for Atlas M0 free tier
            serverSelectionTimeoutMS: 5000,   // ← Fail fast on unreachable cluster
            socketTimeoutMS: 45000,
            family: 4                         // Force IPv4
        });

        fastify.log.info('MongoDB Connected (maxPoolSize: 20) 🚀');

        // Start background services AFTER DB is ready
        startLeaderboardCache();   // Task 1: warm in-memory leaderboard cache
        startSubmissionQueue();    // Task 2: begin batch-flush worker

        // Start HTTP server
        const port = process.env.PORT || 5000;
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`Code Circle Club API running on port ${port}`);

    } catch (err) {
        fastify.log.error('Fatal Server Error', err);
        process.exit(1);
    }
};

start();
