/**
 * Background catch-up of the inferred graphs after the reasoning gate skipped
 * synchronous materialisation (see `KnowledgeEngine.catchUpInferredGraphs`).
 *
 * The scheduler job is a plain cron entry, so its interval is the job's own
 * cron expression and can be changed with the existing cron API. Its handler
 * does not open an agent session: it calls the engine directly, which does
 * nothing unless the stale marker is set.
 */

/** Name of the cron job; the scheduler handler routes it to the engine. */
export const REASONING_CATCHUP_JOB = 'reasoning.catchup';

/** Default interval: every five minutes. A run with nothing stale is a no-op. */
export const REASONING_CATCHUP_CRON = '*/5 * * * *';

/** The scheduler entry registered once at startup (idempotent by name). */
export const REASONING_CATCHUP_DEFAULT = {
  name: REASONING_CATCHUP_JOB,
  cron: REASONING_CATCHUP_CRON,
  prompt: 'internal: rebuild the inferred graphs when the reasoning gate left them stale',
} as const;

/**
 * Scheduler handler for {@link REASONING_CATCHUP_JOB}: one engine call, never
 * throws (a failed run keeps the stale marker and is retried by the next one).
 */
export async function runReasoningCatchupJob(
  engine: { catchUpInferredGraphs(agentId: string): Promise<unknown> },
  agentId: string,
  logger: { error(message: string): void },
): Promise<void> {
  try {
    await engine.catchUpInferredGraphs(agentId);
  } catch (e) {
    logger.error(`Reasoning catch-up error: ${(e as Error).message}`);
  }
}
