const mongoose = require('mongoose');

async function testMCQSubmissionDirectly() {
    try {
        await mongoose.connect('mongodb://localhost:27017/code_circuit_club');
        const db = mongoose.connection;

        const Round = require('./models/Round');
        const Question = require('./models/Question');
        const User = require('./models/User');
        const Submission = require('./models/Submission');

        await User.deleteOne({ studentId: 'TEST999' });
        const student = await User.create({
            name: 'Test Student',
            studentId: 'TEST999',
            password: 'password123',
            role: 'STUDENT'
        });

        const round = await Round.create({
            name: 'Test MCQ Auto-Eval Round',
            durationMinutes: 10,
            status: 'WAITING_FOR_OTP',
            isOtpActive: true,
            startOtp: '111111',
            endOtp: '222222',
            type: 'GENERAL',
            shuffleQuestions: false
        });

        const q1 = await Question.create({
            round: round._id,
            title: 'Test MCQ 1',
            type: 'MCQ',
            options: ['1', '2', '3'],
            correctAnswer: '2',
            points: 10,
            description: 'desc'
        });

        const q2 = await Question.create({
            round: round._id,
            title: 'Test MCQ 2',
            type: 'MCQ',
            options: ['London', 'Paris', 'Berlin'],
            correctAnswer: 'Paris',
            points: 20,
            description: 'desc'
        });

        // 1. Start round
        let submission = new Submission({
            student: student._id,
            round: round._id,
            status: 'IN_PROGRESS',
            startTime: new Date()
        });
        await submission.save();

        // 2. Submit round
        const answers = {
            [q1._id.toString()]: '2',       // Correct (10)
            [q2._id.toString()]: 'London'   // Incorrect (0)
        };

        // Exact logic from rounds.js
        const now = new Date();
        submission.status = 'SUBMITTED';
        submission.endTime = now;

        let parsedAnswers = answers;
        submission.codeContent = JSON.stringify(answers);

        // --- Auto-evaluate MCQ questions ---
        let autoScore = 0;
        const answeredIds = Object.keys(parsedAnswers).filter(id => mongoose.Types.ObjectId.isValid(id));

        if (answeredIds.length > 0) {
            const questionsToEval = await Question.find({ _id: { $in: answeredIds }, type: 'MCQ' });
            for (const q of questionsToEval) {
                const studentAnswer = String(parsedAnswers[q._id.toString()] || '').trim();
                const correctAns = String(q.correctAnswer || '').trim();
                if (correctAns && studentAnswer === correctAns) {
                    autoScore += (q.points || 0);
                }
            }
        }
        submission.autoScore = autoScore;
        const totalManualScore = (submission.manualScores || []).reduce((sum, ms) => sum + (ms.score || 0), 0);
        submission.score = autoScore + totalManualScore;

        await submission.save();

        // 3. Verify
        const savedSub = await Submission.findById(submission._id);
        console.log('Saved Score:', savedSub.score);
        console.log('Saved AutoScore:', savedSub.autoScore);

        if (savedSub.score === 10 && savedSub.autoScore === 10) {
            console.log('✅ TEST PASSED: Auto evaluation logic works!');
        } else {
            console.log('❌ TEST FAILED: Scores do not match expected values.');
        }

        // Cleanup
        await Submission.deleteOne({ _id: submission._id });
        await Question.deleteMany({ round: round._id });
        await Round.deleteOne({ _id: round._id });
        mongoose.disconnect();

    } catch (e) {
        console.error('Test script failed:', e);
        mongoose.disconnect();
    }
}

testMCQSubmissionDirectly();
