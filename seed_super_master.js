require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

async function seedSuperMaster() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/code_circuit_club';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    const studentId = 'RAHUL_RAIMAN';
    const password = 'rahul_raiman';
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingUser = await User.findOne({ studentId });
    if (existingUser) {
        existingUser.role = 'SUPER_MASTER';
        existingUser.password = hashedPassword;
        await existingUser.save();
        console.log('Existing user updated to SUPER_MASTER');
    } else {
        const newUser = new User({
            studentId,
            name: 'Super Master Admin',
            password: hashedPassword,
            role: 'SUPER_MASTER',
            isOnboarded: true
        });
        await newUser.save();
        console.log('New SUPER_MASTER user created');
    }

    await mongoose.connection.close();
    console.log('Done');
}

seedSuperMaster().catch(err => {
    console.error(err);
    process.exit(1);
});
