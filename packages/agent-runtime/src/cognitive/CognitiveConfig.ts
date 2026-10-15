/**
 * CognitiveConfig — reads cognitive-architecture feature flags from the agent's
 * `urn:<agent>:setup` graph (docs/cognitive-architecture, Phase B, B7).
 *
 * `cog.flagCycleManager` (Phase B): when ON, inbound messages are routed through
 * the {@link CycleManager}; when OFF (the default), the legacy `handleMessage`
 * core path runs unchanged. `cog.flagGoalStack` (Phase D): when ON, the goal
 * stack drives Phase 3/4/5; when OFF (the default) only the implicit
 * RespondToUser goal is pushed and behaviour matches Phase C. Each flag is one
 * triple on the config subject, re-queried per read so it toggles with no
 * restart.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

const COGT = 'urn:shared:ontology#cog/';

/** IRI of the per-agent cognitive-config resource in the setup graph. */
function configSubject(agentId: string): string {
  return `urn:${agentId}:setup:cognitive`;
}

/** One cognitive feature flag: its setup-graph name, short key and a one-line description. */
export interface CognitiveFlagInfo {
  /** Triple local name in the setup graph, e.g. `flagGoalStack`. */
  readonly name: string;
  /** Short camelCase key without the `flag` prefix, e.g. `goalStack`. */
  readonly key: string;
  readonly description: string;
}

/** Every cognitive flag, in display order. This is the allowlist for `/cog flag`. */
export const COGNITIVE_FLAGS: readonly CognitiveFlagInfo[] = [
  { name: 'flagCycleManager', key: 'cycleManager', description: 'Route messages through the six-phase cognitive cycle.' },
  { name: 'flagEpisodicMemory', key: 'episodicMemory', description: 'Let the cycle write episodes (messages, tools, replies); arm_goal needs this.' },
  { name: 'flagEpisodicRecall', key: 'episodicRecall', description: 'Allow the recalled episodes and facts to be injected into the prompt (recall itself follows the cycle flag; nothing is injected yet).' },
  { name: 'flagGoalStack', key: 'goalStack', description: 'Manage an explicit goal stack in the cycle.' },
  { name: 'flagProceduralMemory', key: 'proceduralMemory', description: 'Record skill traces per tool call and suggest skills.' },
  { name: 'flagMetacognition', key: 'metacognition', description: 'Raise impasses and write the full reflective marker.' },
  { name: 'flagSelfModelQuery', key: 'selfModelQuery', description: 'Add a self-model block to the prompt.' },
  { name: 'flagRetention', key: 'retention', description: 'Let the retention sweep tier old episodes.' },
  { name: 'flagDebugPanel', key: 'debugPanel', description: 'Expose the read-only cognitive inspection routes.' },
  { name: 'flagInitiative', key: 'initiative', description: 'Allow self-started goal wakes (kill switch for unattended work).' },
];

/**
 * Resolve a user-supplied flag name to its descriptor. Accepts the exact name
 * (`flagGoalStack`) or the short form without the `flag` prefix (`goalstack`),
 * case-insensitive. Returns `undefined` for anything not on the allowlist.
 */
export function resolveCognitiveFlag(input: string): CognitiveFlagInfo | undefined {
  const norm = input.trim().toLowerCase().replace(/^flag/, '');
  return COGNITIVE_FLAGS.find((f) => f.key.toLowerCase() === norm);
}

export class CognitiveConfig {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

  /**
   * Whether the synchronous CycleManager path is enabled. Defaults to `false`
   * when the flag is absent or unparseable, so an unseeded agent keeps the
   * legacy behaviour.
   */
  async isCycleManagerEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagCycleManager');
  }

  /** Set (or clear) the CycleManager flag in the setup graph. */
  async setCycleManagerEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagCycleManager', enabled);
  }

  /**
   * Whether the explicit goal stack (Phase D) is enabled. Defaults to `false`,
   * so an unseeded agent pushes only the implicit RespondToUser goal and its
   * behaviour is identical to Phase C.
   */
  async isGoalStackEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagGoalStack');
  }

  /** Set (or clear) the goal-stack flag in the setup graph. */
  async setGoalStackEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagGoalStack', enabled);
  }

  /**
   * Whether procedural memory (Phase E) is enabled. Defaults to `false`, so an
   * unseeded agent writes no skill traces and surfaces no skill suggestions —
   * behaviour is identical to Phase D.
   */
  async isProceduralMemoryEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagProceduralMemory');
  }

  /** Set (or clear) the procedural-memory flag in the setup graph. */
  async setProceduralMemoryEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagProceduralMemory', enabled);
  }

  /**
   * Whether metacognition (Phase F) is enabled. Defaults to `false`, so an
   * unseeded agent raises no impasses, runs no metacognitive subcycle, and
   * writes only the minimal Phase B reflective marker.
   */
  async isMetacognitionEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagMetacognition');
  }

  /** Set (or clear) the metacognition flag in the setup graph. */
  async setMetacognitionEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagMetacognition', enabled);
  }

  /**
   * Whether the queryable self-model (Phase G) drives Phase 4. Defaults to
   * `false`, so an unseeded agent adds no `[Self]` prompt block and its
   * behaviour is identical to Phase F.
   */
  async isSelfModelQueryEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagSelfModelQuery');
  }

  /** Set (or clear) the self-model-query flag in the setup graph. */
  async setSelfModelQueryEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagSelfModelQuery', enabled);
  }

  /**
   * Whether the episodic retention sweep (Phase H) performs destructive tiering.
   * Defaults to `false`, so even when the retention job is scheduled it leaves
   * every episode untouched until an operator opts in — behaviour is identical
   * to Phase G.
   */
  async isRetentionEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagRetention');
  }

  /** Set (or clear) the episodic-retention flag in the setup graph. */
  async setRetentionEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagRetention', enabled);
  }

  /**
   * Whether the cognitive debug panel (Phase I) read-only inspection routes are
   * exposed. Defaults to `false`: the `/api/cog/inspect/*` endpoints answer 403
   * until an operator opts in, so the debug surface is dev-only.
   */
  async isDebugPanelEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagDebugPanel');
  }

  /** Set (or clear) the cognitive-debug-panel flag in the setup graph. */
  async setDebugPanelEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagDebugPanel', enabled);
  }

  /**
   * Whether self-initiated (initiative) cycles are enabled (docs/initiative-
   * architecture.md §5, §12). Defaults to `false`: with the flag off, goal
   * wakes are hard no-ops in the dispatcher — the agent never acts unattended.
   * This is the kill switch; it is never enabled by default.
   */
  async isInitiativeEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagInitiative');
  }

  /** Set (or clear) the initiative flag in the setup graph. */
  async setInitiativeEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagInitiative', enabled);
  }

  /**
   * Whether the cycle writes episodes (message-received, tool, response). Defaults
   * to `false`: with the cycle on and this flag off, cycle resources, working
   * memory and the reflective marker are still written, but no episodes.
   */
  async isEpisodicMemoryEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagEpisodicMemory');
  }

  /** Set (or clear) the episodic-memory flag in the setup graph. */
  async setEpisodicMemoryEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagEpisodicMemory', enabled);
  }

  /**
   * Whether the recall computed in Phase 2 may be injected into the prompt.
   * Defaults to `false`. The recall itself (reads, retrieval-buffer entries,
   * the marker bit) runs with the cycle flag alone; this flag only marks that a
   * later step may put the recalled entries into the prompt. In this version
   * nothing is injected either way.
   */
  async isEpisodicRecallEnabled(): Promise<boolean> {
    return this.isFlagEnabled('flagEpisodicRecall');
  }

  /** Set (or clear) the episodic-recall flag in the setup graph. */
  async setEpisodicRecallEnabled(enabled: boolean): Promise<void> {
    return this.setFlag('flagEpisodicRecall', enabled);
  }

  /** Read any flag on the {@link COGNITIVE_FLAGS} allowlist by its exact name. */
  async isEnabled(info: CognitiveFlagInfo): Promise<boolean> {
    return this.isFlagEnabled(info.name);
  }

  /** Set any flag on the {@link COGNITIVE_FLAGS} allowlist. */
  async setEnabled(info: CognitiveFlagInfo, enabled: boolean): Promise<void> {
    return this.setFlag(info.name, enabled);
  }

  /** Current value of every flag, keyed by short key. */
  async allFlags(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const f of COGNITIVE_FLAGS) out[f.key] = await this.isFlagEnabled(f.name).catch(() => false);
    return out;
  }

  /** Read one boolean `cog.<flag>` triple; `false` when absent or unparseable. */
  private async isFlagEnabled(flag: string): Promise<boolean> {
    const graph = GraphUriResolver.getSetupGraph(this.agentId);
    const subject = configSubject(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?v WHERE {
        GRAPH <${graph}> { <${subject}> <${COGT}${flag}> ?v }
      } LIMIT 1`);
    const v = res.bindings?.[0]?.v?.value;
    return v === 'true' || v === '1';
  }

  /** Replace one boolean `cog.<flag>` triple in the setup graph. */
  private async setFlag(flag: string, enabled: boolean): Promise<void> {
    const graph = GraphUriResolver.getSetupGraph(this.agentId);
    const subject = configSubject(this.agentId);
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${subject}> <${COGT}${flag}> ?old } }
      WHERE  { GRAPH <${graph}> { <${subject}> <${COGT}${flag}> ?old } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${subject}> <${COGT}${flag}> "${enabled}"^^<http://www.w3.org/2001/XMLSchema#boolean> .
      } }`);
  }
}
