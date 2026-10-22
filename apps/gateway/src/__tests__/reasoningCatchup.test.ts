import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobScheduler } from '@ontofelia/scheduler';
import {
  REASONING_CATCHUP_DEFAULT, REASONING_CATCHUP_JOB, runReasoningCatchupJob,
} from '../services/reasoningCatchup.js';

describe('reasoning catch-up job', () => {
  it('the default entry is a valid cron job that fires within five minutes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcj-'));
    try {
      const scheduler = new JobScheduler(dir);
      const job = await scheduler.addCronJob({
        ...REASONING_CATCHUP_DEFAULT, agentId: 'ontofelia', enabled: false,
      });
      expect(job.name).toBe(REASONING_CATCHUP_JOB);
      const wait = new Date(job.nextRun as string).getTime() - Date.now();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(5 * 60_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the handler calls the engine for the job\'s agent', async () => {
    const engine = { catchUpInferredGraphs: vi.fn(async () => ({ status: 'not-stale' })) };
    const logger = { error: vi.fn() };
    await runReasoningCatchupJob(engine, 'ontofelia', logger);
    expect(engine.catchUpInferredGraphs).toHaveBeenCalledExactlyOnceWith('ontofelia');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the handler swallows and logs an unexpected engine error', async () => {
    const engine = { catchUpInferredGraphs: vi.fn(async () => { throw new Error('boom'); }) };
    const logger = { error: vi.fn() };
    await expect(runReasoningCatchupJob(engine, 'ontofelia', logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
