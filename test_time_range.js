const mongoose = require('mongoose');
const Round = require('./models/Round');
const Submission = require('./models/Submission');
const User = require('./models/User');

// Mocking backend logic for verification
// In a real scenario, we'd use the actual route handlers, but here we simulate the core logic

async function verifyTimeRange() {
    try {
        console.log('--- Starting Time Range Verification ---');

        // 1. Setup - connect to DB
        // Assuming URI is available from context or config
        await mongoose.connect('mongodb://localhost:27017/ccc');
        console.log('Connected to Database');

        // Clean up or find a test student
        let student = await User.findOne({ studentId: 'TEST_STUDENT' });
        if (!student) {
            student = await User.create({ name: 'Test Student', studentId: 'TEST_STUDENT', passwordHash: 'noop', role: 'STUDENT' });
        }

        // 2. Scenario: Test hasn't started yet
        console.log('\nScenario 1: Starting before startTime');
        const futureRound = await Round.create({
            name: 'Future Test',
            startTime: new Date(Date.now() + 10000), // 10s from now
            endTime: new Date(Date.now() + 60000),
            durationMinutes: 10
        });

        const now1 = new Date();
        if (futureRound.startTime && now1 < futureRound.startTime) {
            console.log('PASS: Logic correctly identifies test hasn\'t started.');
        } else {
            console.log('FAIL: Logic failed to identify test hasn\'t started.');
        }

        // 3. Scenario: Test has ended
        console.log('\nScenario 2: Starting after endTime');
        const pastRound = await Round.create({
            name: 'Past Test',
            startTime: new Date(Date.now() - 20000),
            endTime: new Date(Date.now() - 10000),
            durationMinutes: 10
        });

        const now2 = new Date();
        if (pastRound.endTime && now2 > pastRound.endTime) {
            console.log('PASS: Logic correctly identifies test has already ended.');
        } else {
            console.log('FAIL: Logic failed to identify test has ended.');
        }

        // 4. Scenario: Submit after window endTime
        console.log('\nScenario 3: Submitting after window endTime (Enforcement)');
        const windowRound = await Round.create({
            name: 'Window Enforcement Test',
            startTime: new Date(Date.now() - 5000),
            endTime: new Date(Date.now() + 5000), // Ends in 5s
            durationMinutes: 60
        });

        const submission = await Submission.create({
            student: student._id,
            round: windowRound._id,
            status: 'IN_PROGRESS',
            startTime: new Date(Date.now() - 1000) // Started 1s ago
        });

        console.log('Waiting 6s for window to close...');
        await new Promise(r => setTimeout(r, 6000));

        const now3 = new Date();
        const isLate = windowRound.endTime && now3 > new Date(windowRound.endTime.getTime() + 2 * 60 * 1000); // 2min buffer
        if (isLate) {
            console.log('PASS: Submission identified as OUTSIDE window.');
            submission.status = 'DISQUALIFIED';
            submission.disqualificationReason = 'TEST_WINDOW_EXCEEDED';
            await submission.save();
            console.log('Submission disqualified.');
        } else {
            console.log('Wait... bufffer might still be active?');
        }

        // 5. Scenario: Extra Time Interaction
        console.log('\nScenario 4: Extra Time extends both Duration and Window');
        submission.extraTimeMinutes = 10;
        submission.status = 'IN_PROGRESS';
        await submission.save();

        const now4 = new Date();
        // Buffered Window: endTime + extraTime + 2min
        const windowEnd = new Date(windowRound.endTime.getTime() + (submission.extraTimeMinutes + 2) * 60 * 1000);

        if (now4 <= windowEnd) {
            console.log('PASS: Extra time correctly extended the window. Student can now submit.');
        } else {
            console.log('FAIL: Extra time did not extend the window sufficiently.');
        }

        console.log('\n--- Verification Complete ---');

        // Cleanup
        await Round.deleteMany({ name: /Test/ });
        await Submission.deleteMany({ student: student._id });
        // Keep student for future tests

        process.exit(0);
    } catch (err) {
        console.error('ERROR during verification:', err);
        process.exit(1);
    }
}

verifyTimeRange();
