require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const mongoose = require('mongoose');
const fastifyStatic = require("@fastify/static");
const path = require("path");

// fastify.register(fastifyStatic, {
//     root: path.join(__dirname, "../frontend/dist"),
//     prefix: "/",
// });

// fastify.setNotFoundHandler((request, reply) => {
//     if (request.raw.url.startsWith('/api')) {
//         return reply.code(404).send({
//             success: false,
//             message: 'API route not found'
//         });
//     }

//     // SPA fallback
//     return reply.sendFile('index.html');
// });

// Configure CORS for Frontend Interaction
fastify.register(require('@fastify/cors'), {
    origin: (origin, cb) => {
        // Define your exact allowed URLs here
        const allowedOrigins = [
            process.env.FRONTEND_URL, // Your Vercel URL
            'http://localhost:5173',  // Local Vite React
            'http://localhost:3000'   // Local CRA React
        ];

        // 1. Allow requests with no origin (like Postman or curl)
        if (!origin) {
            return cb(null, true);
        }

        // 2. Check if the incoming origin is in our allowed list
        if (allowedOrigins.includes(origin)) {
            return cb(null, true);
        }

        // 3. Reject anything else
        return cb(new Error(`CORS blocked: Origin ${origin} not allowed`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // Added OPTIONS for preflight
    credentials: true
});

// Configure Multipart processing for Bulk Excel Uploads
fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Register Custom Plugins (JWT Authentication & Role Decorators)
fastify.register(require('./plugins/auth'));

// Register Application Routes
fastify.register(require('./routes/auth'), { prefix: '/api/auth' });
fastify.register(require('./routes/rounds'), { prefix: '/api/rounds' });
fastify.register(require('./routes/admin'), { prefix: '/api/admin' });
fastify.register(require('./routes/superadmin'), { prefix: '/api/superadmin' });
fastify.register(require('./routes/attendance'), { prefix: '/api/attendance' });

// Graceful Shutdown Logic
const closeServer = async (signal) => {
    fastify.log.info(`Received signal to terminate: ${signal}`);

    try {
        // Close Fastify HTTP connections first
        await fastify.close();
        fastify.log.info('Fastify server closed.');

        // Safely drain the MongoDB connection pool
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

// Database Connection & Server Boot
const start = async () => {
    try {
        // Connect to MongoDB Atlas with optimized Connection Pooling
        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/code_circuit_club';
        await mongoose.connect(mongoUri, {
            maxPoolSize: 100, // Handle hundreds of concurrent student sessions safely
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            family: 4 // Force IPv4
        });
        fastify.log.info('MongoDB Connected with optimized PoolSize 🚀');

        // Start Node.js Server
        const port = process.env.PORT || 5000;
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`Code Circle Club API is running live on port ${port}`);

    } catch (err) {
        fastify.log.error('Fatal Server Error', err);
        process.exit(1);
    }
};

start();
