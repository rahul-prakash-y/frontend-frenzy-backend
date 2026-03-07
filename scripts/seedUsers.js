/**
 * scripts/seedUsers.js
 * ---------------------
 * Pre-registration script for the Frontend Frenzy event.
 *
 * Run locally (NOT on Render) to pre-hash all student passwords and
 * bulk-insert them into MongoDB Atlas before the event starts.
 *
 * Usage:
 *   node scripts/seedUsers.js
 *
 * Scale up the STUDENTS array to 400 entries before the event.
 * bcrypt work is done on your local CPU — the free-tier server is never touched.
 */

'use strict';

require('dotenv').config(); // Reads MONGO_URI from your local .env
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// ─── Load the User model ──────────────────────────────────────────────────────
// Adjust the path if your project layout differs.
const User = require('../models/User');

// ─── Student Template ─────────────────────────────────────────────────────────
// Replace / extend this array with your full 400-student list.
// Fields must match the User schema (studentId maps to rollNumber here).
const STUDENTS = [
    { name: 'Alice Sharma', email: 'alice@example.com', rollNumber: 'CS2024001', password: 'Alice@1234' },
    { name: 'Bob Mehta', email: 'bob@example.com', rollNumber: 'CS2024002', password: 'Bob@5678' },
    { name: 'Carol Verma', email: 'carol@example.com', rollNumber: 'CS2024003', password: 'Carol@9012' },
];

// ─── Configuration ────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 8;   // Lower than the default 12 — fast on 400 records,
// still secure enough for a short-lived event.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/code_circuit_club';

// ─── Main ─────────────────────────────────────────────────────────────────────
async function seed() {
    console.log(`\n🌱  Frontend Frenzy — Student Pre-Registration Script`);
    console.log(`📦  Total students to seed: ${STUDENTS.length}`);
    console.log(`🔌  Connecting to MongoDB…\n`);

    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000,
        family: 4
    });
    console.log('✅  MongoDB connected.\n');

    // ── Step 1: Hash passwords locally ───────────────────────────────────────
    console.log(`🔐  Hashing passwords with bcrypt (rounds=${BCRYPT_ROUNDS})…`);

    const hashedStudents = [];

    for (let i = 0; i < STUDENTS.length; i++) {
        const s = STUDENTS[i];

        // Progress indicator so you know it isn't frozen on large arrays
        process.stdout.write(`   [${i + 1}/${STUDENTS.length}] Hashing ${s.rollNumber}…`);

        const hashedPassword = await bcrypt.hash(s.password, BCRYPT_ROUNDS);

        hashedStudents.push({
            studentId: s.rollNumber,  // Maps to the unique `studentId` field in User schema
            name: s.name,
            email: s.email,
            password: hashedPassword,
            role: 'STUDENT',
            isOnboarded: false
        });

        process.stdout.write(' done\n');
    }

    console.log(`\n✅  All ${hashedStudents.length} passwords hashed.\n`);

    // ── Step 2: Bulk insert ───────────────────────────────────────────────────
    // ordered: false → if a student already exists (duplicate studentId/email),
    // MongoDB skips that one and inserts the rest. Safe to re-run the script.
    console.log('💾  Inserting into MongoDB via insertMany…');

    try {
        const result = await User.insertMany(hashedStudents, {
            ordered: false,
            rawResult: true
        });

        console.log(`\n✅  Success! ${result.insertedCount} student(s) inserted.`);

        const skipped = hashedStudents.length - result.insertedCount;
        if (skipped > 0) {
            console.log(`⚠️   ${skipped} student(s) skipped — already exist in the database (duplicates ignored).`);
        }

    } catch (err) {
        // MongoBulkWriteError fires when ordered:false has at least one duplicate
        if (err.name === 'MongoBulkWriteError' || err.code === 11000) {
            const inserted = err.result?.nInserted ?? 0;
            const skipped = hashedStudents.length - inserted;
            console.log(`\n✅  Partial insert: ${inserted} student(s) saved.`);
            console.log(`⚠️   ${skipped} student(s) skipped (duplicate studentId or email — already registered).`);
        } else {
            // Unexpected error — re-throw so the stack trace is visible
            throw err;
        }
    }

    // ── Step 3: Disconnect ────────────────────────────────────────────────────
    await mongoose.connection.close();
    console.log('\n🔌  MongoDB disconnected. Seed complete.\n');
    process.exit(0);
}

seed().catch((err) => {
    console.error('\n❌  Fatal seed error:', err);
    mongoose.connection.close().finally(() => process.exit(1));
});
