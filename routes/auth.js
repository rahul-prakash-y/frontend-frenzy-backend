const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { logActivity } = require('../utils/logger');

module.exports = async function (fastify, opts) {

    /**
     * ROUTE: POST /api/auth/login
     * Public route (No auth required)
     * Login for strictly pre-uploaded Students or Admins. 
     */
    fastify.post('/login', async (request, reply) => {
        const { studentId, password } = request.body;

        if (!studentId || !password) {
            return reply.code(400).send({ error: 'Student ID and password are required' });
        }

        try {
            // Find the user by auto-generated student identifier
            const user = await User.findOne({ studentId });

            if (!user) {
                return reply.code(401).send({ error: 'Invalid credentials. User not found.' });
            }

            if (user.isBanned) {
                return reply.code(403).send({
                    error: 'Account suspended. Anti-cheat protocol triggered.',
                    reason: user.banReason
                });
            }

            // Verify Auto-generated Hash Password
            const isMatch = await bcrypt.compare(password, user.password);

            if (!isMatch) {
                return reply.code(401).send({ error: 'Invalid credentials' });
            }

            // Exact JWT Payload Structure definition
            const payload = {
                userId: user._id,
                studentId: user.studentId,
                role: user.role, // 'STUDENT' or 'ADMIN'
                name: user.name,
                isBanned: user.isBanned,
                banReason: user.banReason,
                isOnboarded: user.isOnboarded,
                team: user.team
            };

            // Sign token (valid for a typical hackathon duration plus warmup delay)
            const token = fastify.jwt.sign(payload, { expiresIn: '12h' });

            // ENFORCE SINGLE SESSION: Any token issued before now becomes invalid
            // Use current time, floored to nearest second to match JWT iat precision
            const now = new Date();
            now.setMilliseconds(0);
            user.tokenIssuedAfter = now;
            await user.save();

            // Log LOGIN event
            await logActivity({
                action: 'LOGIN',
                performedBy: { userId: user._id, studentId: user.studentId, name: user.name, role: user.role },
                target: { type: 'User', id: user._id.toString(), label: `${user.studentId} — ${user.role}` },
                ip: request.ip
            });

            return reply.code(200).send({
                success: true,
                token,
                user: payload
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Internal Server Error during Authentication', message: error.message });
        }
    });

    /**
     * ROUTE: POST /api/auth/seed-user
     * Temporary/Admin route to securely pre-upload students. 
     * In a real system, you might have a bulk upload endpoint.
     */
    fastify.post('/seed-user', async (request, reply) => {
        const { studentId, name, password, role } = request.body;

        // Fallback Master Key to setup initial Admin if the database is blank
        const masterKey = request.headers['x-master-key'];
        if (masterKey !== (process.env.MASTER_KEY || 'ccc_master_seed_2026')) {
            return reply.code(403).send({ error: 'Forbidden: Valid Master Key Required' });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);

            const newUser = new User({
                studentId,
                name,
                password: hashedPassword,
                role: role || 'STUDENT'
            });

            await newUser.save();

            // Log CREATED event
            await logActivity({
                action: 'CREATED',
                performedBy: { studentId: 'SYSTEM', name: 'Seed Script', role: 'SYSTEM' },
                target: { type: 'User', id: newUser._id.toString(), label: `${newUser.studentId} (${newUser.role})` },
                ip: request.ip
            });

            return reply.code(201).send({
                success: true,
                message: `${role || 'STUDENT'} successfully registered into the platform`
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(400).send({ error: 'User creation failed', details: error.message });
        }
    });
    /**
     * ROUTE: POST /api/auth/logout
     * Authenticated route. Allows tracing when a user actively clicks 'Logout'.
     */
    fastify.post('/logout', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const user = request.user;

            // Log LOGOUT event
            await logActivity({
                action: 'LOGOUT',
                performedBy: { userId: user.userId, studentId: user.studentId, name: user.name, role: user.role },
                target: { type: 'User', id: user.userId, label: `${user.studentId} — ${user.role}` },
                ip: request.ip
            });

            return reply.code(200).send({ success: true, message: 'Logged out successfully' });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to log out cleanly' });
        }
    });

    /**
     * ROUTE: POST /api/auth/onboard
     * Authenticated route for students to complete their profile.
     */
    fastify.post('/onboard', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { name, email, linkedinProfile, githubProfile, phone, bio, dob, password, department, gender, accommodation } = request.body;
            if (!name || name.trim().length < 2) {
                return reply.code(400).send({ error: 'Valid name is required' });
            }

            const updateData = {
                name: name.trim(),
                email: email ? email.trim() : null,
                linkedinProfile: linkedinProfile ? linkedinProfile.trim() : null,
                githubProfile: githubProfile ? githubProfile.trim() : null,
                phone: phone ? phone.trim() : null,
                bio: bio ? bio.trim() : null,
                dob: dob ? new Date(dob) : null,
                department: department ? department.trim() : null,
                gender: gender || null,
                accommodation: accommodation || null,
                isOnboarded: true
            };

            if (password) {
                if (password.length < 6) {
                    return reply.code(400).send({ error: 'Password must be at least 6 characters long' });
                }
                const hashedPassword = await bcrypt.hash(password, 10);
                updateData.password = hashedPassword;
            }

            const user = await User.findByIdAndUpdate(
                request.user.userId,
                updateData,
                { new: true }
            );

            if (!user) return reply.code(404).send({ error: 'User not found' });

            // Create a new token with updated name and onboarded status
            const payload = {
                userId: user._id,
                studentId: user.studentId,
                role: user.role,
                name: user.name,
                isBanned: user.isBanned,
                banReason: user.banReason,
                isOnboarded: user.isOnboarded
            };
            const token = fastify.jwt.sign(payload, { expiresIn: '12h' });

            await logActivity({
                action: 'ONBOARDED',
                performedBy: { userId: user._id, studentId: user.studentId, name: user.name, role: user.role },
                target: { type: 'User', id: user._id.toString(), label: `${user.studentId} — Onboarding Complete` },
                ip: request.ip
            });

            return reply.send({ success: true, user: payload, token });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to complete onboarding' });
        }
    });

    /**
     * ROUTE: GET /api/auth/profile
     * Authenticated route for fetching user's full profile
     */
    fastify.get('/profile', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const user = await User.findById(request.user.userId).select('-password');
            if (!user) return reply.code(404).send({ error: 'User not found' });

            return reply.send({ success: true, profile: user });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch profile' });
        }
    });

    /**
     * ROUTE: PUT /api/auth/profile
     * Authenticated route for updating user's profile
     */
    fastify.put('/profile', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { name, email, linkedinProfile, githubProfile, phone, bio, dob, department, gender, accommodation } = request.body;

            const updateData = {};
            if (name) updateData.name = name.trim();
            if (email !== undefined) updateData.email = email ? email.trim() : null;
            if (linkedinProfile !== undefined) updateData.linkedinProfile = linkedinProfile ? linkedinProfile.trim() : null;
            if (githubProfile !== undefined) updateData.githubProfile = githubProfile ? githubProfile.trim() : null;
            if (phone !== undefined) updateData.phone = phone ? phone.trim() : null;
            if (bio !== undefined) updateData.bio = bio ? bio.trim() : null;
            if (dob !== undefined) updateData.dob = dob ? new Date(dob) : null;
            if (department !== undefined) updateData.department = department ? department.trim() : null;
            if (gender !== undefined) updateData.gender = gender || null;
            if (accommodation !== undefined) updateData.accommodation = accommodation || null;

            const user = await User.findByIdAndUpdate(
                request.user.userId,
                { $set: updateData },
                { new: true, runValidators: true }
            ).select('-password');

            if (!user) return reply.code(404).send({ error: 'User not found' });

            // Create a new token in case name was updated
            const payload = {
                userId: user._id,
                studentId: user.studentId,
                role: user.role,
                name: user.name,
                isBanned: user.isBanned,
                banReason: user.banReason,
                isOnboarded: user.isOnboarded
            };
            const token = fastify.jwt.sign(payload, { expiresIn: '12h' });

            await logActivity({
                action: 'UPDATED',
                performedBy: { userId: user._id, studentId: user.studentId, name: user.name, role: user.role },
                target: { type: 'User', id: user._id.toString(), label: `${user.studentId} — Profile Updated` },
                ip: request.ip
            });

            return reply.send({ success: true, profile: user, token });
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to update profile' });
        }
    });

};
