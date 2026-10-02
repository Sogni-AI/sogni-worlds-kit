import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDelay, waitForProject, RefusedError } from '../cli/lib/sogni.js';

// A failed project answers 404 forever on the stored-record lookup; the wait
// must learn about the failure from the live lookup instead of hanging.
test('waitForProject stops on a failure the live lookup reports', async () => {
  const client = {
    projects: {
      getResult: async () => ({ id: 'p', status: 'failed', finished: true, jobs: [{ id: 'j', status: 'failed', reason: 'genfailure' }] }),
      get: async () => { const error = new Error('not found'); error.status = 404; throw error; },
    },
  };
  await assert.rejects(waitForProject(client, 'p', { timeoutMs: 5000 }), error => error instanceof RefusedError && /failed: genfailure/.test(error.message));
});

const noSleep = async () => {};
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

test('waitForProject returns the stored record once the project completes', async () => {
  let polls = 0;
  let liveStatus;
  let reads = 0;
  let readsWhileProcessing = 0;
  const client = {
    projects: {
      getResult: async () => {
        polls += 1;
        liveStatus = polls < 3 ? 'processing' : 'completed';
        return { id: 'p', status: liveStatus, finished: liveStatus === 'completed', jobs: [] };
      },
      get: async () => {
        if (liveStatus === 'processing') readsWhileProcessing += 1;
        reads += 1;
        if (reads < 2) throw httpError(404); // the stored record can lag the live one
        return { id: 'p', status: 'completed', completedWorkerJobs: [{ imgID: 'r' }] };
      },
    },
  };
  const result = await waitForProject(client, 'p', { timeoutMs: 20000, sleep: noSleep });
  assert.equal(result.status, 'completed');
  // The stored record does not exist while the project renders; reading it then only spends the request budget.
  assert.equal(readsWhileProcessing, 0);
});

test('waitForProject backs off after a 429 instead of polling through it', async () => {
  let polls = 0;
  const delays = [];
  const client = {
    projects: {
      getResult: async () => {
        polls += 1;
        if (polls <= 3) throw httpError(429);
        return { id: 'p', status: polls < 5 ? 'processing' : 'completed', finished: polls >= 5, jobs: [] };
      },
      get: async () => ({ id: 'p', status: 'completed', completedWorkerJobs: [{ imgID: 'r' }] }),
    },
  };
  await waitForProject(client, 'p', { timeoutMs: 20000, sleep: async ms => { delays.push(ms); } });
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 10_000]);
});

test('pollDelay doubles from 30 s to a 5 min ceiling and resets to the base', () => {
  assert.equal(pollDelay(0), 10_000);
  assert.equal(pollDelay(0, 3000), 3000);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(n => pollDelay(n)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
});

test('waitForProject names the safe-content filter when it withholds the result', async () => {
  const client = {
    projects: {
      getResult: async () => ({ id: 'p', status: 'completed', finished: true, jobs: [{ id: 'j', status: 'completed', urlUnavailable: 'sensitiveContent' }] }),
      get: async () => ({ id: 'p', status: 'completed', completedWorkerJobs: [] }),
    },
  };
  await assert.rejects(waitForProject(client, 'p', { timeoutMs: 5000 }), /safe-content filter/);
});
