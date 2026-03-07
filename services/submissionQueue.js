/**
 * submissionQueue.js
 * -------------------
 * Task 2: In-Memory Submission Queue (Batch Processing)
 *
 * Strategy:
 *  - Student POSTs a submission → payload is pushed to submissionQueue []
 *    and the HTTP response is returned immediately (non-blocking).
 *  - A background setInterval drains up to BATCH_SIZE entries every
 *    FLUSH_INTERVAL_MS using Mongoose's insertMany() with ordered:false
 *    so a single duplicate key error doesn't abort the entire batch.
 *  - Duplicate submissions (same student + round) are silently swallowed
 *    thanks to { ordered: false } + the unique index on Submission.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Submission = require('../models/Submission');

// Path to the "lifeboat" dead letter log
const DEAD_LETTER_LOG = path.join(__dirname, '../failed_submissions.log');

// Helper to prevent JSON.stringify from crashing the server on circular refs/BigInts
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    } catch (err) {
        return JSON.stringify({ error: 'Unserializable payload', reason: err.message, rawLength: Array.isArray(obj) ? obj.length : 1 });
    }
}

// ─── In-Memory Queue ──────────────────────────────────────────────────────────

/** @type {Object[]} Raw submission payload objects waiting to be persisted. */
const submissionQueue = [];

/** Whether a flush is currently in progress. */
let isFlushing = false;

// ─── Configuration ────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5 * 1000; // 5 seconds
const BATCH_SIZE = 50;              // Max docs per insertMany call

// ─── Queue API ────────────────────────────────────────────────────────────────

/**
 * enqueueSubmission(payload)
 *  Push a validated submission payload onto the in-memory queue.
 *  Returns the current queue length (useful for monitoring logs).
 *
 * @param {Object} payload - The Submission document fields, e.g.:
 *   { student, round, status, codeContent, autoScore, … }
 * @returns {number} New queue length
 */
function enqueueSubmission(payload) {
    submissionQueue.push({
        ...payload,
        _enqueuedAt: Date.now()  // Internal timestamp for queue-age monitoring
    });
    return submissionQueue.length;
}

/**
 * getQueueLength()
 *  For health checks / monitoring endpoints.
 */
function getQueueLength() {
    return submissionQueue.length;
}

// ─── Background Flush Worker ──────────────────────────────────────────────────

/**
 * flushQueue()
 *  Drains up to BATCH_SIZE items from the front of the queue and persists
 *  them to MongoDB in a single insertMany call.
 *
 *  Uses `ordered: false` so that a duplicate-key error on one document
 *  does NOT prevent the rest of the batch from being inserted.
 */
async function flushQueue() {
    if (isFlushing || submissionQueue.length === 0) {
        return; // Nothing to do, or previous flush still running
    }

    isFlushing = true;

    // Atomically splice up to BATCH_SIZE items out of the front of the queue
    const batch = submissionQueue.splice(0, BATCH_SIZE);

    try {
        const result = await Submission.insertMany(batch, {
            ordered: false,     // Continue on duplicate-key errors
            rawResult: true     // Get detailed write result back
        });

        console.info(
            `[SubmissionQueue] Flushed batch: ${result.insertedCount} inserted, ` +
            `${batch.length - result.insertedCount} skipped (duplicates). ` +
            `Queue remaining: ${submissionQueue.length}`
        );

    } catch (err) {
        // BulkWriteError is expected when ordered:false encounters duplicates.
        // The driver still throws if ALL inserts fail, so we handle it here.
        if (err.name === 'MongoBulkWriteError' || err.code === 11000) {
            const inserted = err.result?.nInserted ?? 0;
            console.warn(
                `[SubmissionQueue] Partial batch insert: ${inserted}/${batch.length} saved. ` +
                `Duplicate key errors silently discarded.`
            );
            // Do NOT re-queue — duplicates are expected (student hitting submit twice)
        } else {
            // Unexpected error — we can't save to MongoDB.
            // DO NOT re-queue infinitely. This will blow up RAM if the DB is permanently down.
            // Task 1: Write to the dead letter log as our "Lifeboat"
            console.error('[SubmissionQueue] Unexpected flush error. Writing to dead letter log.', err.message);
            // Task: Mirror to stdout for Render's 48-hour log retention
            console.error('[BACKUP_DATA]', safeStringify(batch));
            try {
                const logEntry = { timestamp: new Date().toISOString(), error: err.message, batch };
                fs.appendFileSync(DEAD_LETTER_LOG, safeStringify(logEntry) + '\n', 'utf8');
                console.info('[SubmissionQueue] Successfully wrote failed batch to failed_submissions.log');
            } catch (fsErr) {
                console.error('[SubmissionQueue] CRITICAL FATAL: Could not write to dead letter log either!', fsErr.message);
                // At this point we must re-queue as an absolute last resort, though RAM will climb
                submissionQueue.unshift(...batch);
            }
        }
    } finally {
        isFlushing = false;
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * startSubmissionQueue()
 *  Call once at server startup (after DB connection is established).
 *  Registers the background flush worker on a fixed interval.
 */
function startSubmissionQueue() {
    console.info(
        `[SubmissionQueue] Background flush worker started ` +
        `(interval: ${FLUSH_INTERVAL_MS / 1000}s, batch size: ${BATCH_SIZE}).`
    );
    setInterval(flushQueue, FLUSH_INTERVAL_MS);
}

/**
 * flushNow()
 *  Graceful-shutdown drain. Bypasses the isFlushing guard and the 5-second
 *  interval to immediately flush ALL remaining items in the queue before
 *  the process exits (called on SIGINT / SIGTERM).
 *
 *  Processes in BATCH_SIZE chunks so a single insertMany call can't choke
 *  on a 400-item queue all at once. Each chunk uses { ordered: false } so
 *  one duplicate doesn't abort the rest of the batch.
 */
async function flushNow() {
    if (submissionQueue.length === 0) {
        console.info('[SubmissionQueue] flushNow: queue already empty, nothing to flush.');
        return;
    }

    console.info(`[SubmissionQueue] flushNow: flushing ${submissionQueue.length} item(s) before shutdown…`);

    // Force-release any in-flight lock so we don't deadlock on shutdown
    isFlushing = false;

    while (submissionQueue.length > 0) {
        const batch = submissionQueue.splice(0, BATCH_SIZE);

        try {
            const result = await Submission.insertMany(batch, {
                ordered: false,  // Skip duplicates, save the rest
                rawResult: true
            });
            console.info(
                `[SubmissionQueue] flushNow batch: ${result.insertedCount}/${batch.length} saved.`
            );
        } catch (err) {
            if (err.name === 'MongoBulkWriteError' || err.code === 11000) {
                const inserted = err.result?.nInserted ?? 0;
                console.warn(
                    `[SubmissionQueue] flushNow partial: ${inserted}/${batch.length} saved ` +
                    `(duplicates discarded).`
                );
            } else {
                // Unexpected error during shutdown flush.
                console.error('[SubmissionQueue] flushNow unexpected error:', err.message);
                // Task: Mirror to stdout for Render's 48-hour log retention
                console.error('[BACKUP_DATA]', safeStringify(batch));
                try {
                    const logEntry = { timestamp: new Date().toISOString(), event: 'SHUTDOWN_FLUSH', error: err.message, batch };
                    fs.appendFileSync(DEAD_LETTER_LOG, safeStringify(logEntry) + '\n', 'utf8');
                    console.info('[SubmissionQueue] SHUTDOWN: Wrote failed batch to failed_submissions.log');
                } catch (fsErr) {
                    console.error('[SubmissionQueue] SHUTDOWN CRITICAL: Failed to write dead letter log.', fsErr.message);
                }
                break; // Avoid infinite loop on persistent DB failure during shutdown
            }
        }
    }

    console.info('[SubmissionQueue] flushNow: drain complete.');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    startSubmissionQueue,
    enqueueSubmission,
    getQueueLength,
    flushNow
};
