import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    // We are simulating 100 students hitting ONE of your four load-balanced servers
    vus: 100, 
    // We will sustain this attack for 30 seconds
    duration: '30s', 
};

export default function () {
    const BASE_URL = 'https://your-backend-1.onrender.com/api';

    // 1. Attack the Leaderboard (Testing the O(1) RAM Cache)
    const leaderboardRes = http.get(`${BASE_URL}/rounds/leaderboard`);
    check(leaderboardRes, {
        'Leaderboard returned 200 OK': (r) => r.status === 200,
        // If the CPU freezes, the response time will spike. We demand it stays under 500ms.
        'Leaderboard is fast (< 500ms)': (r) => r.timings.duration < 500,
    });

    // 2. Attack the Submission Endpoint (Testing the RAM Queue)
    const payload = JSON.stringify({
        student: `load_tester_${__VU}`, // Unique ID per virtual user
        answers: { q1: "A", q2: "B" }
    });
    
    const params = { headers: { 'Content-Type': 'application/json' } };
    
    const submitRes = http.post(`${BASE_URL}/rounds/test_round_1/enqueue-submit`, payload, params);
    check(submitRes, {
        'Submit returned 200 OK': (r) => r.status === 200,
        'Submit is fast (< 500ms)': (r) => r.timings.duration < 500,
    });

    // Students don't click 100 times a second. We simulate 1 click per second per user.
    sleep(1); 
}