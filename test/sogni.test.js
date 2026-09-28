import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForProject, RefusedError } from '../cli/lib/sogni.js';

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

test('waitForProject returns the stored record once the project completes', async () => {
  let calls = 0;
  const client = {
    projects: {
      getResult: async () => ({ id: 'p', status: calls < 1 ? 'processing' : 'completed', finished: calls >= 1, jobs: [] }),
      get: async () => {
        calls += 1;
        if (calls < 2) { const error = new Error('not found'); error.status = 404; throw error; }
        return { id: 'p', status: 'completed', completedWorkerJobs: [{ imgID: 'r' }] };
      },
    },
  };
  const result = await waitForProject(client, 'p', { timeoutMs: 20000 });
  assert.equal(result.status, 'completed');
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
