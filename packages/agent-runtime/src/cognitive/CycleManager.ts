/**
 * CycleManager — the synchronous six-phase cognitive cycle
 * (docs/cognitive-architecture/03-cognitive-cycle.md, Phase B).
 *
 * One cycle is run per inbound turn. In Phase B the three middle phases
 * (goal-management, action, response) are *delegated* to the existing
 * AgentRuntime core via the `core` callback; the cycle brackets that call and
 * reifies the cognitive record around it:
 *
 *   1 Perception      — message text / sender onto the perception buffer (B5)
 *   2 Comprehension   — episodic and semantic recall for the turn, read-only,
 *                       before the LLM call (Comprehension.ts)
 *   3 Goal management ┐
 *   4 Action          ├ delegated to `core()` (the legacy LLM + tool loop)
 *   5 Response        ┘
 *   6 Reflection      — a ReflectiveMarker into cog:meta (B6)
 *
 * Every cognitive write is wrapped so it can NEVER alter or fail the user
 * response: the cycle returns exactly what `core()` returned. Because nothing
 * reads these graphs yet in Phase B, the records are written *after* the core
 * call (when the session id is known); later phases will move perception ahead
 * of the LLM call.
 */

import {
  OWNER_USER_KEY,
  cogUserKey,
  compareIsoDesc,
  createLogger,
  isHumanOwnerTurn,
  type MessageEnvelope,
  type TriplestoreAdapter,
} from '@ontofelia/core';
import {
  GraphRegistry,
  GraphUriResolver,
  EpisodicMemory,
  sparqlIri,
  ProceduralMemory,
  SelfModel,
  type TraceInput,
  type SelfView,
} from '@ontofelia/semantic-memory';
import {
  WorkingMemory,
  OVERFLOW_SALIENCE,
  type WMEntryInput,
  type WorkingMemoryOptions,
} from './WorkingMemory.js';
import {
  assemblePrompt,
  diffCognitiveBlocks,
  type Assembled,
  type BlockDiff,
  type WorkspaceEntry,
} from './PromptAssembler.js';
import type { AttentionSettings, PromptMode, PromptSettings } from './CognitiveConfig.js';
import {
  GoalStack,
  RESPOND_TO_USER,
  goalBelongsTo,
  type Goal,
  type GoalTransition,
  type GoalViewer,
} from './GoalStack.js';
import { detectGoalSignal, entityOverlap, goalFromIntent, goalSalience } from './GoalLifecycle.js';
import { writeGoalEpisode } from './GoalEpisodes.js';
import { looksLikeSecret } from './privacyClass.js';
import {
  comprehend,
  type ComprehensionResult,
  type ComprehensionDeps,
} from './Comprehension.js';
import {
  buildPerception,
  classifyIntent,
  resolvePerception,
  type Perception,
  type PerceptionSource,
} from './Perception.js';
import {
  Metacognition,
  type ImpasseInput,
  type ImpasseKind,
  type ReflectiveMarkerInput,
} from './Metacognition.js';

/** How many learned skills Phase 3 may surface for the active goal type (E4). */
const SKILL_SUGGESTION_K = 5;
/** How many learned tool sequences Phase 3 may surface (E4). */
const SEQUENCE_SUGGESTION_K = 2;

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The six phase kinds, in cycle order; the array index + 1 is the ordinal. */
const PHASE_KINDS = [
  'perception',
  'comprehension',
  'goal-management',
  'action',
  'response',
  'reflection',
] as const;

export interface CycleResult<T> {
  cycleId: string;
  cycleUri: string;
  status: 'completed' | 'aborted';
  result: T;
}

/**
 * A tool-execution event captured during the delegated core (C3). Events are
 * buffered by the per-cycle recorder and replayed as episodes after core, so
 * the episodic chain stays in temporal order (message → tool calls → response).
 */
export interface ToolEpisodeEvent {
  phase: 'called' | 'completed';
  toolName: string;
  /** Correlation id linking a `called` event to its `completed` event. */
  callId: string;
  occurredAt: Date;
  /** Redacted, value-free summary of the arguments — never raw secrets. */
  argsBrief?: string;
  outcome?: 'success' | 'error';
  durationMs?: number;
  errorClass?: string;
}

/** Sink the runtime tool loop calls; a no-op (undefined) on the legacy path. */
export type ToolEpisodeRecorder = (ev: ToolEpisodeEvent) => void;

/**
 * Phase 3/4 hook (Phase D). The core calls this once it has resolved the
 * session id but before the LLM call; it runs the goal-management decision
 * tree and returns the `[Active goal]` text to splice into the prompt (or
 * `undefined` when the goal stack is disabled). A no-op on the legacy path.
 */
export type GoalContextProvider = (sessionId: string) => Promise<string | undefined>;

/**
 * Records the inbound `message-received` episode of a conversational turn
 * before the core runs its tools, and returns its IRI (undefined in initiative
 * mode, or when the write failed). Idempotent per cycle. The core calls it once
 * the session id is resolved and after the goal hook, so the episode still
 * carries the turn's active goal.
 */
export type InboundEpisodeRecorder = (sessionId: string) => Promise<string | undefined>;

/**
 * Phase 1 hook. The core calls it once per turn with what it already computed
 * (resolved entities, parse result, stored claims) and before the LLM call. It
 * is pure and synchronous: the perception record is kept in memory for the later
 * phases and written to the store only by the queued persist.
 */
export type PerceptionRecorder = (source: PerceptionSource) => Perception;

/**
 * Phase 2 hook. The core calls it once per turn after perception and before the
 * goal hook and the LLM call. It only reads (episodes of the sender, one-hop
 * facts of the perceived entities); the result stays in memory for the later
 * phases and reaches the retrieval buffer only through the queued persist.
 * Resolves to `undefined` on an unattended cycle and when the read itself
 * failed; it never throws.
 */
export type ComprehensionRecorder = (sessionId: string) => Promise<ComprehensionResult | undefined>;

/** The delegated core; receives the tool sink and the phase hooks. */
export type CoreFn<T> = (
  recordTool: ToolEpisodeRecorder,
  prepareGoals: GoalContextProvider,
  recordInbound: InboundEpisodeRecorder,
  perceive: PerceptionRecorder,
  comprehendHook: ComprehensionRecorder,
) => Promise<T>;

/** The delegated streaming core: yields the consumer's chunks as they happen. */
export type StreamCoreFn<C> = (
  recordTool: ToolEpisodeRecorder,
  prepareGoals: GoalContextProvider,
  recordInbound: InboundEpisodeRecorder,
  perceive: PerceptionRecorder,
  comprehendHook: ComprehensionRecorder,
) => AsyncIterable<C>;

export interface RunCycleOptions {
  /** When true, Phase 3 manages an explicit goal stack (cog.flagGoalStack). */
  goalsEnabled?: boolean;
  /** When true, Phase 5 writes one cogt:SkillTrace per tool call (cog.flagProceduralMemory). */
  proceduralEnabled?: boolean;
  /**
   * When true (cog.flagMetacognition), phases may raise `cogt:Impasse`s, the
   * cycle runs the S1–S4 metacognitive subcycle to resolve each, and Phase 6
   * writes the *full* `cogt:ReflectiveMarker` instead of the minimal Phase B
   * marker. OFF restores the Phase B reflection exactly.
   */
  metacognitionEnabled?: boolean;
  /**
   * When true (cog.flagSelfModelQuery), Phase 4 seeds a `[Self]` prompt block
   * from `SelfModel.queryFor(goalType)` and constraint pressure is attributed
   * from the self-model's constraints. OFF adds no block and leaves the Phase F
   * constraint-pressure heuristic untouched.
   */
  selfModelEnabled?: boolean;
  /**
   * When explicitly `false` (cog.flagEpisodicMemory off), the cycle writes no
   * episodes; cycle resources, working memory and the reflective marker are
   * still written. Absent or `true` keeps the prior behaviour.
   */
  episodicEnabled?: boolean;
  /**
   * Optional real-time sink for the cognitive phases so a live status UI (e.g.
   * the Telegram progress checklist) can show them explicitly. Best-effort and
   * off the persistence path; failures are swallowed.
   */
  onPhase?: (phase: 'perception' | 'goal_management' | 'reflection', label: string, data?: unknown) => void;
  /**
   * When true, `runCycle` resolves only after this cycle's cognitive records are
   * written (the pre-queue behaviour). Default false: the records are queued per
   * session, in order, and the reply returns without waiting for them. Tests set
   * it to read the records straight after the call.
   */
  awaitPersist?: boolean;
  /**
   * Read-only lookup of the existing nodes the given mentioned entity names
   * denote for this turn's sender (lower-cased name -> node IRIs). Called only
   * from the queued persist, never on the reply path; a failure is reported to
   * `onError` and leaves the names unresolved.
   */
  resolveEntities?: (names: string[]) => Promise<Map<string, string[]>>;
  /**
   * Read-only one-hop facts of entity IRIs for this turn's sender (their own
   * graph and the worldview). Called from Phase 2, before the LLM call; absent
   * means no semantic recall.
   */
  entityFacts?: ComprehensionDeps['entityFacts'];
  /**
   * `cog.flagEpisodicRecall`. In this version it only records whether a later
   * step may put the recalled entries into the prompt; the recall itself, the
   * working-memory entries and the marker bit follow the cycle flag alone.
   */
  episodicRecallEnabled?: boolean;
  /**
   * How the cognitive prompt blocks are built (docs/cognitive-architecture/09
   * §2). `off` (the default, and always for an unattended cycle): the legacy
   * strings, byte for byte. `shadow`: the prompt assembler also runs and its
   * output and a diff against the blocks actually sent are recorded; the prompt
   * is unchanged. `live`: the blocks come from the assembler; the `[Recalled]`
   * block additionally needs `episodicRecallEnabled`.
   */
  promptMode?: PromptMode;
  /** θ and the token caps for the assembler; defaults apply when absent. */
  promptSettings?: PromptSettings;
  /**
   * Attention and carry-over (docs/cognitive-architecture/04 §6-§7, 07 §6). When
   * present, the queued persist carries the previous cycle's entries of the
   * same session and user into this cycle, applies the goal-steered salience
   * rules, applies the capacity, and marks the previous working graph closed.
   * Absent (the default): none of that happens. The runtime passes it whenever
   * the cycle manager is on.
   */
  attention?: AttentionSettings;
  /**
   * Cycle mode (docs/initiative-architecture.md §6). `'conversational'` (the
   * default) is byte-for-byte the prior behaviour. `'initiative'` runs an
   * unattended cycle: Phase 3 does NOT seed the implicit RESPOND_TO_USER goal
   * (there is no user to respond to) and Phase 6 records an initiative episode
   * capturing the trigger, outcome and reason.
   */
  mode?: 'conversational' | 'initiative';
  /**
   * IRI of the goal that triggered this initiative cycle. In initiative mode
   * this goal becomes the active context for Phase 3/4. Ignored in
   * conversational mode.
   */
  initiativeGoalUri?: string;
}

/** Goal lifecycle records a cycle collects for its queued persist. */
interface GoalExtras {
  /** Transitions of goals during the turn (episodes are written from them). */
  events: GoalTransition[];
  /** The competition decided this turn: winner and losers (a `ChooseGoal` record). */
  choice?: { winner: string; losers: string[] };
  /** The implicit RespondToUser goal serving this cycle, resolved at its end. */
  implicitUri?: string;
}

/** Sessions (per user) whose newest working graph the carry-over remembers. */
const LAST_CYCLE_MAX = 1000;
/** How many levels of parent goals reach the goalBuffer. */
const MAX_GOAL_PARENT_DEPTH = 5;

/** Most recent intent first (creation time), then higher priority. */
function byRecentIntent(a: Goal, b: Goal): number {
  return compareIsoDesc(a.createdAt, b.createdAt) || b.priority - a.priority;
}

/**
 * Instants measured in memory while a cycle runs; they become the phase
 * boundaries (see {@link CycleManager.writeCycleAndPhases}).
 */
interface PhaseMarks {
  cycleStart: Date;
  /** The perception record was computed (end of Phase 1). */
  perceivedAt?: Date;
  /** The goal hook started / returned (Phase 3). */
  goalStart?: Date;
  goalEnd?: Date;
  /** The core returned (end of Phase 5). */
  coreEnd?: Date;
}

/** A flagged impasse paired with the resolution its subcycle chose (F3). */
interface ResolvedImpasse {
  flaggedUri: string;
  resolved: boolean;
}

/** Tiny FNV-1a hash (hex). Used to fingerprint the already-redacted args brief. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function newId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Salience of the self-model entries written for the prompt assembler. */
const SELF_SALIENCE = { capability: 0.7, constraint: 0.9 } as const;

/**
 * What the prompt assembler produced next to the prompt actually sent (shadow
 * mode). Stored in the cycles graph by the queued persist.
 */
interface ShadowRecord {
  assembledText: string;
  tokens: number;
  droppedForeign: number;
  diff: BlockDiff;
  cut: Assembled['cut'];
}

/** New skill traces after which a consolidation is requested (doc 06 §5). */
export const CONSOLIDATION_TRACE_THRESHOLD = 50;

export interface CycleManagerOptions {
  /** Default for {@link RunCycleOptions.awaitPersist}; a per-call value wins. */
  awaitPersist?: boolean;
}

export class CycleManager {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    /** Optional sink for cognitive-write failures (kept off the user path). */
    private readonly onError?: (err: unknown) => void,
    private readonly defaults: CycleManagerOptions = {},
  ) {}

  /**
   * Tail of the persistence queue per session: a cycle's records are written
   * only after the previous cycle of the same session finished writing, so the
   * episode chain and the prior-cycle satisfaction backfill keep their order.
   * Different sessions run independently.
   */
  private readonly persistTails = new Map<string, Promise<void>>();
  /**
   * The newest cycle whose working graph was written, per session and user, for
   * the carry-over into the next cycle. In memory: after a restart the first
   * cycle of a session simply has nothing to carry. Bounded.
   */
  private readonly lastCycle = new Map<string, string>();
  /**
   * (session, user) pairs whose stale implicit goals were already cleaned up by
   * this process (the first touch of a session; see {@link CycleManager.manageGoals}).
   */
  private readonly touchedGoalSessions = new Set<string>();
  /** Background work (queued persists, triggered consolidations) not yet settled. */
  private readonly inFlight = new Set<Promise<unknown>>();

  private tracesSinceConsolidation = 0;
  private consolidationTrigger?: () => Promise<unknown>;
  private consolidationThreshold = CONSOLIDATION_TRACE_THRESHOLD;

  /**
   * Register the callback that runs a consolidation once enough new traces have
   * been written. The check is a counter increment; the callback does the work
   * (no model call) in the background and its failures go to `onError`.
   */
  setConsolidationTrigger(
    trigger: (() => Promise<unknown>) | undefined,
    threshold = CONSOLIDATION_TRACE_THRESHOLD,
  ): void {
    this.consolidationTrigger = trigger;
    this.consolidationThreshold = threshold;
  }

  /** Reset the new-trace counter (a consolidation just ran, whoever started it). */
  resetTraceCounter(): void {
    this.tracesSinceConsolidation = 0;
  }

  private noteTracesWritten(n: number): void {
    if (n <= 0 || !this.consolidationTrigger) return;
    this.tracesSinceConsolidation += n;
    if (this.tracesSinceConsolidation < this.consolidationThreshold) return;
    this.tracesSinceConsolidation = 0;
    this.track(
      Promise.resolve()
        .then(() => this.consolidationTrigger?.())
        .catch((e) => this.onError?.(e)),
    );
  }

  private track<P extends Promise<unknown>>(p: P): P {
    this.inFlight.add(p);
    const done = () => {
      this.inFlight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  /**
   * Resolve once every queued cycle record (and any triggered consolidation) has
   * settled. The runtime calls this on a clean stop so queued writes are not lost.
   */
  async flushPending(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Queue `job` behind the session's earlier jobs; resolves when `job` is done. */
  private enqueuePersist(sessionId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.persistTails.get(sessionId) ?? Promise.resolve();
    // The tail never rejects: a failed job reports to onError and the queue goes on.
    const run = prev.then(job).catch((e) => this.onError?.(e));
    this.persistTails.set(sessionId, run);
    this.track(run);
    run.then(() => {
      if (this.persistTails.get(sessionId) === run) this.persistTails.delete(sessionId);
    });
    return run;
  }

  private readonly logger = createLogger('cognitive-cycle');

  /**
   * Run one cognitive cycle around `core`. The user-visible result is whatever
   * `core` returns (or throws); cognitive bookkeeping is best-effort.
   *
   * `sessionIdOf` extracts the resolved session id from the core result so the
   * per-session cognitive graphs can be addressed.
   */
  async runCycle<T>(
    envelope: MessageEnvelope,
    core: CoreFn<T>,
    sessionIdOf: (result: T) => string,
    responseTextOf?: (result: T) => string | undefined,
    options: RunCycleOptions = {},
  ): Promise<T> {
    const cycle = this.openCycle(envelope, options);
    let result: T;
    let coreError: unknown;
    let status: 'completed' | 'aborted' = 'completed';
    try {
      result = await core(cycle.recordTool, cycle.prepareGoals, cycle.recordInbound, cycle.perceive, cycle.comprehend);
    } catch (e) {
      status = 'aborted';
      coreError = e;
      result = undefined as unknown as T;
    }
    let sessionId = 'unknown';
    let responseText: string | undefined;
    try {
      sessionId =
        (status === 'completed' && result !== undefined ? sessionIdOf(result) : undefined) ||
        envelope.routingHints?.sessionId ||
        'unknown';
      responseText =
        status === 'completed' && result !== undefined ? responseTextOf?.(result) : undefined;
    } catch (extractErr) {
      this.onError?.(extractErr);
    }
    await cycle.finish(status, sessionId, responseText);

    if (coreError) throw coreError;
    return result;
  }

  /**
   * Run one cognitive cycle around a streaming core. Every chunk the core
   * yields is passed on unchanged and as it arrives; the cycle only observes
   * it. The cycle is closed after the stream ends: `completed` when the core
   * finished or the consumer stopped after the final chunk, `aborted` when the
   * core threw or the consumer stopped iterating (or aborted) before it. The
   * records are queued like a non-stream cycle's. A core error is re-thrown to
   * the consumer after the cycle is closed.
   *
   * `describe` reads a chunk and reports the session id it carries, the final
   * response text, and whether the chunk is the final one; the last value seen
   * for each wins.
   */
  async *runCycleStream<C>(
    envelope: MessageEnvelope,
    core: StreamCoreFn<C>,
    describe: (chunk: C) => { sessionId?: string; text?: string; final?: boolean } | undefined,
    options: RunCycleOptions = {},
  ): AsyncGenerator<C> {
    const cycle = this.openCycle(envelope, options);
    let sessionId: string | undefined;
    let responseText: string | undefined;
    let sawFinal = false;
    let coreDone = false;
    let coreFailed = false;
    let status: 'completed' | 'aborted';
    const inner = core(cycle.recordTool, cycle.prepareGoals, cycle.recordInbound, cycle.perceive, cycle.comprehend);
    try {
      for await (const chunk of inner) {
        try {
          const d = describe(chunk);
          if (d?.sessionId) sessionId = d.sessionId;
          if (d?.text !== undefined) responseText = d.text;
          if (d?.final) sawFinal = true;
        } catch (extractErr) {
          this.onError?.(extractErr);
        }
        yield chunk;
      }
      coreDone = true;
    } catch (e) {
      coreFailed = true;
      throw e;
    } finally {
      // Reached on normal end, on a core error and when the consumer stops early.
      status = !coreFailed && (coreDone || sawFinal) ? 'completed' : 'aborted';
      await cycle.finish(
        status,
        sessionId || envelope.routingHints?.sessionId || 'unknown',
        status === 'completed' ? responseText : undefined,
      );
    }
  }

  /**
   * Set up one cycle: the per-cycle tool sink, the goal hook and the inbound
   * episode recorder, plus `finish`, which closes the cycle and queues its
   * records. Shared by {@link runCycle} and {@link runCycleStream}.
   */
  private openCycle(envelope: MessageEnvelope, options: RunCycleOptions) {
    const cycleId = `cyc-${newId()}`;
    const cycleUri = `urn:${this.agentId}:cog:cycle:${cycleId}`;
    const startedAt = new Date();
    this.logger.info({ agent: this.agentId, cycleId, phase: 'perception' }, `cycle ${cycleId} started`);
    const emitPhase = (phase: 'perception' | 'goal_management' | 'reflection', label: string, data?: unknown) => {
      try { options.onPhase?.(phase, label, data); } catch { /* status UI is best-effort */ }
    };
    emitPhase('perception', 'Perception');

    // Buffer tool events so they can be written as episodes in temporal order
    // after the core completes (see writeEpisodicAndRetrieval). The closure is
    // per-cycle, so concurrent cycles never share state.
    const toolEvents: ToolEpisodeEvent[] = [];
    const recordTool: ToolEpisodeRecorder = (ev) => {
      toolEvents.push(ev);
    };

    // Phase 3/4 (Phase D). The core invokes this once the session is resolved;
    // it runs the goal decision tree and hands back the `[Active goal]` prompt
    // text. The chosen goal's URI is captured per-cycle so Phase 5 can backfill
    // `cogt:partOfGoal` onto this turn's episodes. Disabled => no goal work.
    let activeGoalUri: string | undefined;
    let activeGoalType: string | undefined;
    // Set when Phase 3 sees more than one substantive active goal — a
    // goal-conflict impasse signal for the metacognitive subcycle (F2).
    let goalConflict = false;
    // Goal lifecycle records of this turn, written by the queued persist.
    const goalExtras: GoalExtras = { events: [] };
    const mode = options.mode ?? 'conversational';
    // Phase 1 (perception) in memory, plus the phase boundaries measured as the
    // hooks run. `perceivedAt` closes Phase 1; the goal hook brackets Phase 3.
    let perception: Perception | undefined;
    const marks: PhaseMarks = { cycleStart: startedAt };
    const perceive: PerceptionRecorder = (source) => {
      perception = buildPerception(
        {
          text: envelope.text || '',
          senderId: envelope.sender?.id,
          senderIsOwner: envelope.sender?.isOwner === true,
          channel: envelope.channel ? String(envelope.channel) : undefined,
        },
        source,
      );
      marks.perceivedAt = new Date();
      return perception;
    };
    let inboundEpisodeUri: string | undefined;
    // Phase 2 in memory. Read-only: the result is kept for the later phases and
    // written to the retrieval buffer by the queued persist.
    let comprehension: ComprehensionResult | undefined;
    // Set when Phase 2 already looked up the pending entities to the end, so the
    // queued persist does not repeat the lookup.
    let pendingResolved = false;
    const comprehendHook: ComprehensionRecorder = async (sessionId) => {
      if (mode !== 'conversational') return undefined;
      try {
        const userKey = cogUserKey(envelope.sender);
        // The active goal for this sender (read-only); the implicit
        // RespondToUser goal is filtered out by comprehend().
        let goal: Goal | undefined;
        if (options.goalsEnabled) {
          try {
            const active = await new GoalStack(
              this.triplestore,
              this.registry,
              this.agentId,
              sessionId,
              undefined,
              this.viewerOf(envelope),
            ).active();
            goal = active.find((g) => g.goalType !== RESPOND_TO_USER);
          } catch (e) {
            this.onError?.(e);
          }
        }
        const result = await comprehend(
          {
            episodic: new EpisodicMemory(this.triplestore, this.agentId),
            entityFacts: options.entityFacts,
            resolveEntities: options.resolveEntities,
            onError: (e) => this.onError?.(e),
          },
          {
            userKey,
            sessionId,
            perception,
            activeGoalUri: goal?.uri,
            activeGoalType: goal?.goalType,
            inboundEpisodeUri,
            episodicEnabled: options.episodicEnabled !== false,
          },
        );
        comprehension = result;
        if (result.pendingResolved && result.perception) {
          perception = result.perception;
          pendingResolved = true;
        }
        return result;
      } catch (e) {
        this.onError?.(e);
        return undefined;
      }
    };
    // Prompt assembler (docs/cognitive-architecture/09 §2). Only conversational
    // turns use it; an unattended cycle always keeps the legacy strings.
    const promptMode: PromptMode = mode === 'conversational' ? (options.promptMode ?? 'off') : 'off';
    const userKey = cogUserKey(envelope.sender);
    // Goal and self entries produced for the assembler; the queued persist writes
    // them to working memory (nothing is awaited before the LLM call for them).
    const queuedWm: WMEntryInput[] = [];
    // Goal / skill / self entries of the in-memory working-memory view.
    const phaseView: WorkspaceEntry[] = [];
    let shadow: ShadowRecord | undefined;
    const prepareGoalsInner: GoalContextProvider = async (sessionId) => {
      if (!options.goalsEnabled) return undefined;
      try {
        const gs = new GoalStack(
          this.triplestore,
          this.registry,
          this.agentId,
          sessionId,
          undefined,
          this.viewerOf(envelope),
          // Episodes of this turn's transitions are written by the queued persist.
          (t) => {
            goalExtras.events.push(t);
          },
        );
        const managed =
          mode === 'conversational'
            ? await this.manageConversationalGoals(gs, envelope, sessionId, startedAt, perception, goalExtras)
            : await this.manageInitiativeGoals(gs, options.initiativeGoalUri);
        const goal = managed.goal;
        goalConflict = managed.conflict;
        activeGoalUri = goal.uri;
        activeGoalType = goal.goalType;
        emitPhase('goal_management', 'Deliberation', { goalType: goal.goalType });
        const sections = [this.renderActiveGoal(goal)];
        if (promptMode !== 'off') {
          const body = sections[0].slice('[Active goal]\n'.length);
          phaseView.push({ buffer: 'goalBuffer', entryKind: 'goal-active', text: body, salience: goalSalience(0), forUser: userKey });
          queuedWm.push({ buffer: 'goalBuffer', entryKind: 'goal-active', payload: body, salience: goalSalience(0), forGoal: goal.uri });
          // Parents of the top goal, nearest first (doc 04 §4).
          for (const p of await this.goalParents(gs, goal)) {
            phaseView.push({ buffer: 'goalBuffer', entryKind: 'goal-parent', text: p.text, salience: p.salience, forUser: userKey });
            queuedWm.push({ buffer: 'goalBuffer', entryKind: 'goal-parent', payload: p.text, salience: p.salience, forGoal: p.uri });
          }
        }
        // E4 — bias action selection with learned skills for this goal type.
        if (options.proceduralEnabled) {
          const skillsText = await this.surfaceSkillSuggestions(
            sessionId,
            cycleId,
            cycleUri,
            goal.goalType,
            cogUserKey(envelope.sender),
          );
          if (skillsText) {
            sections.push(skillsText.text);
            if (promptMode !== 'off') {
              // Written to working memory by surfaceSkillSuggestions as before.
              for (const it of skillsText.items) {
                phaseView.push({
                  buffer: 'retrievalBuffer',
                  entryKind: it.kind,
                  text: it.text,
                  salience: it.score,
                  retrievalScore: it.score,
                  agentLevel: true,
                  forUser: userKey,
                });
              }
            }
          }
        }
        // G2 — seed the `[Self]` block from the queryable self-model.
        if (options.selfModelEnabled) {
          const selfText = await this.renderSelfBlock(goal.goalType);
          if (selfText) {
            sections.push(selfText.text);
            if (promptMode !== 'off') {
              const add = (entryKind: 'capability' | 'constraint', text: string, salience: number) => {
                phaseView.push({ buffer: 'selfBuffer', entryKind, text, salience, agentLevel: true, forUser: userKey });
                queuedWm.push({ buffer: 'selfBuffer', entryKind, payload: text, salience });
              };
              for (const c of selfText.caps) add('capability', c, SELF_SALIENCE.capability);
              for (const c of selfText.cons) add('constraint', c, SELF_SALIENCE.constraint);
            }
          }
        }
        return sections.join('\n\n');
      } catch (e) {
        this.onError?.(e);
        return undefined;
      }
    };
    const prepareGoals: GoalContextProvider = async (sessionId) => {
      marks.goalStart = new Date();
      try {
        const legacy = await prepareGoalsInner(sessionId);
        if (promptMode === 'off') return legacy;
        return this.composeCognitivePrompt(promptMode, legacy, {
          perception,
          comprehension,
          phaseView,
          userKey,
          options,
          setShadow: (r) => {
            shadow = r;
          },
          cycleId,
        });
      } finally {
        marks.goalEnd = new Date();
      }
    };

    // The inbound episode is written ahead of the core (conversational turns
    // only) so tools can reference it as a goal mandate. persist() reuses it
    // instead of writing a second one.
    // (declared above, before the Phase 2 hook that must exclude it)
    // The `about` the inbound episode was written with (before resolution).
    let inboundAbout: string[] = [];
    const recordInbound: InboundEpisodeRecorder = async (sessionId) => {
      if (mode !== 'conversational') return undefined;
      if (options.episodicEnabled === false) return undefined;
      if (inboundEpisodeUri) return inboundEpisodeUri;
      try {
        inboundEpisodeUri = await this.appendInboundEpisode(
          envelope,
          sessionId,
          cycleId,
          startedAt,
          activeGoalUri,
          perception,
        );
        inboundAbout = perception?.about ?? [];
      } catch (e) {
        this.onError?.(e);
      }
      return inboundEpisodeUri;
    };

    const finish = async (
      status: 'completed' | 'aborted',
      sessionId: string,
      responseText: string | undefined,
    ): Promise<void> => {
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();
      if (status === 'aborted') {
        this.logger.error({ agent: this.agentId, cycleId, durationMs }, `cycle ${cycleId} aborted`);
      } else {
        this.logger.info({ agent: this.agentId, cycleId, phase: 'reflection', durationMs }, `cycle ${cycleId} completed in ${durationMs}ms`);
        emitPhase('reflection', 'Reflection');
      }
      const queued = this.enqueuePersist(sessionId, () =>
        this.persist(
          envelope,
          sessionId,
          cycleId,
          cycleUri,
          startedAt,
          endedAt,
          status,
          responseText,
          toolEvents,
          activeGoalUri,
          activeGoalType,
          options.proceduralEnabled === true,
          options.metacognitionEnabled === true,
          goalConflict,
          options.selfModelEnabled === true,
          mode,
          options.initiativeGoalUri,
          inboundEpisodeUri,
          options.episodicEnabled !== false,
          perception,
          { ...marks, coreEnd: endedAt },
          pendingResolved ? undefined : options.resolveEntities,
          inboundAbout,
          comprehension,
          {
            wm: queuedWm,
            shadow,
            goal: goalExtras,
            ...(mode === 'conversational' && options.attention
              ? { attention: options.attention, goalsEnabled: options.goalsEnabled === true }
              : {}),
          },
        ),
      );
      if (options.awaitPersist ?? this.defaults.awaitPersist ?? false) await queued;
    };

    return { recordTool, prepareGoals, recordInbound, perceive, comprehend: comprehendHook, finish };
  }

  /**
   * Phase 3 of an unattended initiative cycle (docs/initiative-architecture.md
   * §6): the triggering goal is the active context and the implicit
   * RESPOND_TO_USER goal is NEVER seeded — there is no user to respond to.
   */
  private async manageInitiativeGoals(
    gs: GoalStack,
    initiativeGoalUri?: string,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const active = await gs.active();
    const substantives = active.filter((g) => g.goalType !== RESPOND_TO_USER);
    if (initiativeGoalUri) {
      const triggering = await gs.get(initiativeGoalUri);
      if (triggering) return { goal: triggering, conflict: substantives.length > 1 };
    }
    if (substantives.length > 0) return { goal: substantives[0], conflict: substantives.length > 1 };
    if (active.length > 0) return { goal: active[0], conflict: false };
    // No goal at all is not expected (the trigger came from a due wake); fall
    // back to the implicit goal only as a last resort so the cycle can run.
    return { goal: await gs.ensureImplicit(), conflict: false };
  }

  /**
   * Phase 3 of a conversational turn — the goal decision tree (doc 07 §5; see
   * GoalLifecycle.ts for the rules). Only goals that belong to the sender take
   * part: the owner's view also holds other users' goals, which a turn of the
   * owner must neither continue, close nor compete with.
   *
   *  0. First touch of the session by this process: implicit goals left over
   *     from earlier cycles are resolved (no migration needed).
   *  1. A satisfaction cue resolves, a cancel cue abandons the top goal. Armed
   *     goals (owner mandate / wake) are left to their tools.
   *  2. Entities of the message overlap a goal's entities: continue that goal.
   *     Else the intent creates a new goal (question, command, request,
   *     topic-reference); chit-chat and feedback create none. A follow-up
   *     without entities of the same goal type as the latest goal continues it.
   *  Otherwise the earlier behaviour: continue an active goal, else the
   *  implicit RespondToUser goal, which is resolved when the cycle ends.
   *
   * When several goals compete, the one with the most recent intent wins and a
   * `cogt:ChooseGoal` record names the winner and the losers.
   */
  private async manageConversationalGoals(
    gs: GoalStack,
    envelope: MessageEnvelope,
    sessionId: string,
    cycleStart: Date,
    perception: Perception | undefined,
    extras: GoalExtras,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const userKey = cogUserKey(envelope.sender);
    const text = envelope.text || '';

    // 0. Hygiene on the first touch of the session by this process.
    const touched = `${sessionId}\u0000${userKey}`;
    if (!this.touchedGoalSessions.has(touched)) {
      if (this.touchedGoalSessions.size >= 5000) this.touchedGoalSessions.clear();
      this.touchedGoalSessions.add(touched);
      try {
        await gs.resolveStaleImplicit(cycleStart, new Date(), userKey);
      } catch (e) {
        this.onError?.(e);
      }
    }

    const intent = perception?.intent ?? classifyIntent(text);
    const about = perception?.about ?? [];
    const mine = (await gs.active()).filter((g) => goalBelongsTo(g, userKey));
    const isArmed = (g: Goal) => g.mandatedBy !== undefined || g.wakeAt !== undefined || g.wakeEvery !== undefined;
    const armed = mine.filter((g) => g.goalType !== RESPOND_TO_USER && isArmed(g));
    let candidates = mine.filter((g) => g.goalType !== RESPOND_TO_USER && !isArmed(g)).sort(byRecentIntent);

    // 1. The user closes the top goal.
    const signal = detectGoalSignal(text, intent);
    if (signal && candidates.length === 0) {
      // A closer with nothing to close creates no goal ("passt" is not a topic).
      return armed[0] ? { goal: armed[0], conflict: false } : this.implicitGoal(gs, userKey, extras);
    }
    if (signal) {
      const [top, ...rest] = candidates;
      await gs.setStatus(top.uri, signal === 'satisfied' ? 'resolved' : 'abandoned');
      candidates = rest;
      const next = candidates[0] ?? armed[0];
      if (next) return { goal: next, conflict: false };
      return this.implicitGoal(gs, userKey, extras);
    }

    // 2a. Continue a goal whose entities overlap the message's entities.
    const overlapping = candidates
      .filter((g) => entityOverlap(g.about, about) > 0)
      .sort((a, b) => entityOverlap(b.about, about) - entityOverlap(a.about, about) || byRecentIntent(a, b));
    if (overlapping.length > 0) {
      const winner = overlapping[0];
      return this.decided(winner, overlapping.slice(1), extras);
    }

    // 2b. A new goal from the intent; it is the most recent intent, so it wins.
    // A message without entities of its own that asks for the same kind of goal
    // as the most recent one is a follow-up ("and how fast is it?"): it
    // continues that goal instead of stacking a second one of the same type.
    const wanted = goalFromIntent(intent, text);
    const followUp = wanted !== undefined && about.length === 0 && candidates[0]?.goalType === wanted.goalType;
    if (wanted && !followUp) {
      const actor = envelope.sender?.id
        ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
        : undefined;
      const uri = await gs.push({
        goalType: wanted.goalType,
        goalLabel: wanted.label,
        priority: 0.7,
        triggeredByUser: actor,
        forUser: userKey,
        about,
      });
      const created = await gs.get(uri);
      if (created) return this.decided(created, candidates, extras);
    }

    // No new goal: keep the earlier behaviour.
    if (candidates.length > 0) return this.decided(candidates[0], candidates.slice(1), extras);
    if (armed.length > 0) return { goal: armed[0], conflict: armed.length > 1 };
    return this.implicitGoal(gs, userKey, extras);
  }

  /** The goal of the turn when `losers` competed with it: record the choice. */
  private decided(winner: Goal, losers: Goal[], extras: GoalExtras): { goal: Goal; conflict: boolean } {
    if (losers.length === 0) return { goal: winner, conflict: false };
    extras.choice = { winner: winner.uri, losers: losers.map((g) => g.uri) };
    return { goal: winner, conflict: true };
  }

  /** The implicit RespondToUser goal of this cycle; resolved when the cycle ends. */
  private async implicitGoal(
    gs: GoalStack,
    userKey: string,
    extras: GoalExtras,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const goal = await gs.ensureImplicit(new Date(), userKey);
    if (goal.goalType === RESPOND_TO_USER) extras.implicitUri = goal.uri;
    return { goal, conflict: false };
  }

  /**
   * Parents of `goal` for the goalBuffer, nearest first: 0.7, minus 0.1 per
   * further level, never below 0.3 ({@link goalSalience}). Read through the
   * viewer-scoped stack, so a parent the sender may not see is not followed.
   */
  private async goalParents(
    gs: GoalStack,
    goal: Goal,
  ): Promise<Array<{ uri: string; text: string; salience: number }>> {
    const out: Array<{ uri: string; text: string; salience: number }> = [];
    const seen = new Set<string>([goal.uri]);
    let cur = goal;
    for (let depth = 1; depth <= MAX_GOAL_PARENT_DEPTH && cur.parentGoal; depth++) {
      if (seen.has(cur.parentGoal)) break;
      const parent = await gs.get(cur.parentGoal);
      if (!parent) break;
      seen.add(parent.uri);
      const shortType = parent.goalType.split('/').pop() ?? parent.goalType;
      out.push({ uri: parent.uri, text: `${parent.goalLabel} (type: ${shortType})`, salience: goalSalience(depth) });
      cur = parent;
    }
    return out;
  }

  /**
   * Off the reply path: the goal episodes of this turn, the `ChooseGoal` record
   * and the end of the cycle's implicit goal. Best effort, each on its own.
   */
  private async finishGoals(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    episodicEnabled: boolean,
    goal: GoalExtras,
  ): Promise<void> {
    const userKey = cogUserKey(envelope.sender);
    if (episodicEnabled) {
      const em = new EpisodicMemory(this.triplestore, this.agentId);
      for (const t of goal.events) {
        try {
          await writeGoalEpisode(em, t, { sessionId, cycleId });
        } catch (e) {
          this.onError?.(e);
        }
      }
    }
    if (goal.choice) {
      try {
        await this.writeChooseGoal(sessionId, cycleUri, userKey, goal.choice);
      } catch (e) {
        this.onError?.(e);
      }
    }
    if (goal.implicitUri) {
      try {
        // The implicit goal serves one cycle only (doc 07 §5.1), so sessions do
        // not keep a zombie.
        await new GoalStack(
          this.triplestore,
          this.registry,
          this.agentId,
          sessionId,
          undefined,
          this.viewerOf(envelope),
        ).setStatus(goal.implicitUri, 'resolved');
      } catch (e) {
        this.onError?.(e);
      }
    }
  }

  /** `cogt:ChooseGoal`: which goal won a competition, which lost, and why. */
  private async writeChooseGoal(
    sessionId: string,
    cycleUri: string,
    userKey: string,
    choice: NonNullable<GoalExtras['choice']>,
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);
    const uri = `${cycleUri}_choose`;
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}ChooseGoal> .`,
      `<${uri}> <${COGT}partOfCycle> <${cycleUri}> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
      `<${uri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}winner> ${sparqlIri(choice.winner)} .`,
      `<${uri}> <${COGT}chosenBecause> "most-recent-intent" .`,
    ];
    for (const l of choice.losers) lines.push(`<${uri}> <${COGT}loser> ${sparqlIri(l)} .`);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /** The goal-forest view of this turn's sender (see {@link GoalStack}). */
  private viewerOf(envelope: MessageEnvelope): GoalViewer {
    return { userId: cogUserKey(envelope.sender), isOwner: envelope.sender?.isOwner === true };
  }

  /** Phase 4 — render the active goal as an `[Active goal]` prompt section. */
  private renderActiveGoal(goal: Goal): string {
    const shortType = goal.goalType.split('/').pop() ?? goal.goalType;
    const lines = [
      '[Active goal]',
      `- ${goal.goalLabel} (type: ${shortType}, priority: ${goal.priority})`,
    ];
    if (goal.successCriterion) lines.push(`- Success criterion: ${goal.successCriterion}`);
    if (goal.currentStep) lines.push(`- Current step: ${goal.currentStep}`);
    return lines.join('\n');
  }

  /**
   * Build the cognitive prompt blocks with the prompt assembler from this
   * cycle's in-memory working-memory view (perception + comprehension + the
   * goal, skill and self entries). Shadow: record the output and its diff
   * against `legacy` (the text actually sent) and return `legacy`. Live: return
   * the assembled text. Never throws: on a failure the legacy text goes out.
   */
  private composeCognitivePrompt(
    mode: 'shadow' | 'live',
    legacy: string | undefined,
    ctx: {
      perception?: Perception;
      comprehension?: ComprehensionResult;
      phaseView: WorkspaceEntry[];
      userKey: string;
      options: RunCycleOptions;
      setShadow: (r: ShadowRecord) => void;
      cycleId: string;
    },
  ): string | undefined {
    try {
      const view: WorkspaceEntry[] = [];
      for (const e of ctx.perception?.entries ?? []) {
        view.push({
          buffer: e.buffer,
          entryKind: e.entryKind,
          text: e.payload,
          salience: e.salience,
          forUser: ctx.userKey,
        });
      }
      for (const e of ctx.comprehension?.entries ?? []) {
        view.push({
          buffer: 'retrievalBuffer',
          entryKind: e.kind,
          text: e.payload,
          salience: e.score,
          retrievalScore: e.score,
          forUser: e.forUser,
        });
      }
      view.push(...ctx.phaseView);
      const settings = ctx.options.promptSettings;
      const assembled = assemblePrompt({
        entries: view,
        theta: settings?.theta,
        userKey: ctx.userKey,
        recallEnabled: ctx.options.episodicRecallEnabled === true,
        recalledTokenCap: settings?.recalledTokenCap,
        totalTokenCap: settings?.totalTokenCap,
      });
      if (mode === 'live') return assembled.text === '' ? undefined : assembled.text;
      const diff = diffCognitiveBlocks(legacy, assembled.text);
      ctx.setShadow({
        assembledText: assembled.text,
        tokens: assembled.tokens,
        droppedForeign: assembled.droppedForeign,
        diff,
        cut: assembled.cut,
      });
      // Debug log: sizes and block names only, never the recalled text.
      this.logger.debug(
        { agent: this.agentId, cycleId: ctx.cycleId, tokens: assembled.tokens, droppedForeign: assembled.droppedForeign, diff },
        `prompt shadow for cycle ${ctx.cycleId}`,
      );
      return legacy;
    } catch (e) {
      this.onError?.(e);
      return legacy;
    }
  }

  /**
   * E4 — surface the top learned skills/sequences for `goalType` into the
   * retrieval buffer (entryKind `skill-suggestion` / `sequence-suggestion`,
   * carrying a score) and render the `[Skills that worked]` prompt block
   * (doc 06 §4/§6). Procedural memory *biases* action selection — it does not
   * dictate it. Returns `undefined` when nothing has been learned yet.
   */
  private async surfaceSkillSuggestions(
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    goalType: string,
    userKey: string,
  ): Promise<{ text: string; items: Array<{ kind: string; text: string; score: number }> } | undefined> {
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const [skills, sequences] = await Promise.all([
      pm.suggestSkills(goalType, SKILL_SUGGESTION_K),
      pm.suggestSequenceSkills(goalType, SEQUENCE_SUGGESTION_K),
    ]);
    if (skills.length === 0 && sequences.length === 0) return undefined;

    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId, userKey);
    const goalPhaseUri = `${cycleUri}_3`;
    const procGraph = pm.graphUri();
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    const lines: string[] = ['[Skills that worked before for this kind of goal]'];
    const items: Array<{ kind: string; text: string; score: number }> = [];
    for (const s of skills) {
      await wm.write(
        {
          buffer: 'retrievalBuffer',
          entryKind: 'skill-suggestion',
          payload: s.toolName,
          salience: s.score,
          retrievalScore: s.score,
          sourceGraph: procGraph,
          refersTo: s.skillUri,
        },
        goalPhaseUri,
      );
      const parts = [`used ${s.successCount}×`, `${pct(s.successRate)} success`];
      if (s.satisfactionRate > 0) parts.push(`satisfied ${pct(s.satisfactionRate)}`);
      if (s.meanDurationMs > 0) parts.push(`~${Math.round(s.meanDurationMs)} ms avg`);
      lines.push(`• ${s.toolName} — ${parts.join(', ')}`);
      items.push({ kind: 'skill-suggestion', text: lines[lines.length - 1].slice(2), score: s.score });
    }
    for (const seq of sequences) {
      await wm.write(
        {
          buffer: 'retrievalBuffer',
          entryKind: 'sequence-suggestion',
          payload: seq.steps.map((st) => st.toolName).join(' → '),
          salience: seq.successRate,
          retrievalScore: seq.successRate,
          sourceGraph: procGraph,
          refersTo: seq.seqUri,
        },
        goalPhaseUri,
      );
      const chain = seq.steps.map((st) => st.toolName).join(' → ');
      lines.push(`• [sequence] ${chain} (${seq.successCount}×, ${pct(seq.successRate)} success)`);
      items.push({ kind: 'sequence-suggestion', text: lines[lines.length - 1].slice(2), score: seq.successRate });
    }
    return { text: lines.join('\n'), items };
  }

  /**
   * G2 — render the `[Self]` prompt block from the queryable self-model
   * (doc 08 §2.2): capabilities relevant to the active goal type and the
   * agent's constraints. Returns `undefined` when the self graph holds no
   * capabilities/constraints yet, so an unmigrated agent adds nothing.
   */
  private async renderSelfBlock(
    goalType: string,
  ): Promise<{ text: string; caps: string[]; cons: string[] } | undefined> {
    const sm = new SelfModel(this.triplestore, this.agentId);
    const view: SelfView = await sm.queryFor(goalType);
    if (view.capabilities.length === 0 && view.constraints.length === 0) return undefined;
    const lines: string[] = ['[Self]'];
    const caps: string[] = [];
    const cons: string[] = [];
    if (view.capabilities.length > 0) {
      lines.push('Capabilities relevant to this goal:');
      for (const c of view.capabilities) {
        const reqs = c.requires.length > 0 ? ` (uses ${c.requires.join(', ')})` : '';
        lines.push(`• ${c.label}${reqs}`);
        caps.push(`${c.label}${reqs}`);
      }
    }
    if (view.constraints.length > 0) {
      lines.push('Constraints I must respect:');
      for (const c of view.constraints) {
        const by = c.enforcedBy ? ` [${c.enforcedBy}]` : '';
        lines.push(`• ${c.label}${by}`);
        cons.push(`${c.label}${by}`);
      }
    }
    return { text: lines.join('\n'), caps, cons };
  }

  private async persist(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
    responseText?: string,
    toolEvents: ToolEpisodeEvent[] = [],
    activeGoalUri?: string,
    activeGoalType?: string,
    proceduralEnabled = false,
    metacognitionEnabled = false,
    goalConflict = false,
    selfModelEnabled = false,
    mode: 'conversational' | 'initiative' = 'conversational',
    initiativeGoalUri?: string,
    inboundEpisodeUri?: string,
    episodicEnabled = true,
    perception?: Perception,
    marks: PhaseMarks = { cycleStart: startedAt, coreEnd: endedAt },
    resolveEntities?: RunCycleOptions['resolveEntities'],
    inboundAbout: string[] = [],
    comprehension?: ComprehensionResult,
    extras: {
      wm: WMEntryInput[];
      shadow?: ShadowRecord;
      goal?: GoalExtras;
      attention?: AttentionSettings;
      goalsEnabled?: boolean;
    } = { wm: [] },
  ): Promise<void> {
    const perceptionPhaseUri = `${cycleUri}_1`;
    // Capacity and drop accounting for this cycle's working-memory writes. Every
    // drop of an entry above the overflow salience is counted; one impasse per
    // cycle is raised from the total (metacognition on only).
    const overflow = { dropped: 0 };
    const wmOpts: WorkingMemoryOptions | undefined = extras.attention
      ? {
          capacity: extras.attention.capacity,
          onDrop: (d) => {
            if (d.salience > OVERFLOW_SALIENCE) overflow.dropped++;
          },
        }
      : undefined;
    // Conversational turns write the perception record (computed before the LLM
    // call); a turn whose core never reached the hook (the context build threw)
    // gets the envelope-only record. Initiative turns keep the earlier write.
    let record =
      mode === 'initiative'
        ? undefined
        : (perception ??
          buildPerception({
            text: envelope.text || '',
            senderId: envelope.sender?.id,
            senderIsOwner: envelope.sender?.isOwner === true,
            channel: envelope.channel ? String(envelope.channel) : undefined,
          }));
    // Entities no stored fact named are resolved here, off the reply path, with
    // a read-only lookup. The result feeds the ner-result entries, the response
    // episode and (append-only) the inbound episode written before the tool loop.
    if (record && record.pending.length > 0 && resolveEntities) {
      try {
        const found = await resolveEntities(record.pending);
        record = resolvePerception(record, found);
      } catch (e) {
        this.onError?.(e);
      }
    }
    if (record && episodicEnabled && inboundEpisodeUri) {
      const late = record.about.filter((a) => !inboundAbout.includes(a));
      if (late.length > 0) {
        try {
          await new EpisodicMemory(this.triplestore, this.agentId).addAbout(inboundEpisodeUri, late);
        } catch (e) {
          this.onError?.(e);
        }
      }
    }
    await this.writePerception(envelope, sessionId, cycleId, perceptionPhaseUri, record, wmOpts);
    // Phase 2 result (computed before the LLM call) onto the retrieval buffer.
    // An empty recall writes nothing; the marker bit reads the entry count.
    const retrievalHits = comprehension?.entries.length ?? 0;
    if (comprehension && retrievalHits > 0) {
      await this.writeRecall(envelope, sessionId, cycleId, `${cycleUri}_2`, comprehension, wmOpts);
    }
    // Goal and self entries produced for the prompt assembler (Phase 3).
    if (extras.wm.length > 0) {
      try {
        await this.writeQueuedWm(envelope, sessionId, cycleId, `${cycleUri}_3`, extras.wm, wmOpts);
      } catch (e) {
        this.onError?.(e);
      }
    }
    // Carry-over from the previous cycle and the goal-steered salience rules.
    if (extras.attention) {
      await this.carryAndAttend(envelope, sessionId, cycleId, activeGoalUri, extras.attention, extras.goalsEnabled === true, wmOpts);
    }
    if (extras.goal) await this.finishGoals(envelope, sessionId, cycleId, cycleUri, episodicEnabled, extras.goal);
    if (episodicEnabled) {
      await this.writeEpisodes(
        envelope,
        sessionId,
        cycleId,
        startedAt,
        endedAt,
        responseText,
        toolEvents,
        activeGoalUri,
        inboundEpisodeUri,
        record,
      );
    }
    // Initiative episode (docs/initiative-architecture.md §6): one auditable
    // record per unattended cycle — trigger, outcome and reason. Written only in
    // initiative mode, so conversational persistence is byte-identical.
    if (mode === 'initiative' && episodicEnabled) {
      await this.writeInitiativeEpisode(
        envelope,
        sessionId,
        cycleId,
        startedAt,
        endedAt,
        status,
        responseText,
        toolEvents,
        activeGoalUri ?? initiativeGoalUri,
      );
    }
    if (proceduralEnabled) {
      // E3 — judge the *previous* cycle from this turn's inbound text, then
      // record this turn's traces. Order matters: backfill first so it targets
      // only prior cycles (this cycle's traces aren't written yet, and we also
      // exclude the current cycleId explicitly).
      await this.backfillPriorSatisfaction(sessionId, cycleId, envelope.text || '');
      const written = await this.writeSkillTraces(
        sessionId,
        cycleId,
        toolEvents,
        activeGoalUri,
        activeGoalType,
      );
      this.noteTracesWritten(written);
    }
    await this.writeCycleAndPhases(
      sessionId,
      cycleUri,
      startedAt,
      endedAt,
      status,
      mode === 'initiative' ? OWNER_USER_KEY : cogUserKey(envelope.sender),
      marks,
      toolEvents,
    );
    if (extras.shadow) {
      try {
        await this.writePromptShadow(sessionId, cycleUri, cogUserKey(envelope.sender), extras.shadow);
      } catch (e) {
        this.onError?.(e);
      }
    }
    // Phase 6 reflection. With metacognition ON, detect impasses, run the
    // S1–S4 subcycle for each, and write the *full* marker; OFF restores the
    // minimal Phase B marker exactly (the flag-off equivalence guarantee).
    if (metacognitionEnabled) {
      await this.runMetacognition({
        cycleId,
        cycleUri,
        status,
        responseText,
        toolEvents,
        retrievalHits,
        goalConflict,
        selfModelEnabled,
        wmOverflow: overflow.dropped > 0 && extras.attention ? { dropped: overflow.dropped, capacity: extras.attention.capacity } : undefined,
        userKey: mode === 'initiative' ? OWNER_USER_KEY : cogUserKey(envelope.sender),
      });
    } else {
      await this.writeReflectiveMarker(cycleUri, status);
    }
  }

  /**
   * Phase F — the metacognitive half of Phase 6 (doc 08 §5–§6). Detects this
   * cycle's impasses, runs the bounded S1–S4 subcycle to resolve each, and
   * writes the full `cogt:ReflectiveMarker` with the cycle's monitoring
   * signals. All best-effort: it never touches the (already-sent) user reply.
   */
  private async runMetacognition(ctx: {
    cycleId: string;
    cycleUri: string;
    status: 'completed' | 'aborted';
    responseText?: string;
    toolEvents: ToolEpisodeEvent[];
    retrievalHits: number;
    goalConflict: boolean;
    selfModelEnabled: boolean;
    wmOverflow?: { dropped: number; capacity: number };
    userKey?: string;
  }): Promise<void> {
    const meta = new Metacognition(this.triplestore, this.agentId);

    // --- Detect impasses from the cycle's vantage point (F2). ----------------
    const impasses = this.detectImpasses(ctx);

    // --- S1–S4 subcycle per impasse (F3). The subcycle is a bounded policy
    // lookup plus two writes: it performs no LLM call and cannot itself raise
    // an impasse, so there is no recursion and the cycle can never loop. ------
    const resolved: ResolvedImpasse[] = [];
    for (const input of impasses) {
      try {
        const flagged = await meta.flagImpasse(input); // S1 meta-perception + S2 density
        this.logger.warn(
          { agent: this.agentId, kind: flagged.kind, chronic: flagged.chronic, phase: input.flaggedInPhase },
          `impasse flagged: ${flagged.kind}${flagged.chronic ? ' (chronic)' : ''}`,
        );
        const resolution = meta.pickResolution(flagged.kind, {
          attempt: 0,
          recentDensity: 0,
          chronic: flagged.chronic, // S2 → chronic short-circuits to ask-user
        }); // S3 meta-decision
        // S4 resume: ask-user is *recorded* but left for the human; everything
        // else is auto-resolved by the policy. Chronic always defers to user.
        const autoResolved = resolution !== 'ask-user';
        if (autoResolved) await meta.resolveImpasse(flagged.id, resolution, 'metacog');
        resolved.push({ flaggedUri: flagged.id, resolved: autoResolved });
      } catch (e) {
        this.onError?.(e);
      }
    }

    // --- Phase 6 full reflective marker (F4). --------------------------------
    const toolsUsed = new Set(ctx.toolEvents.map((e) => e.callId)).size;
    const toolErrors = ctx.toolEvents.filter(
      (e) => e.phase === 'completed' && e.outcome === 'error',
    ).length;
    const flaggedImpasse = resolved.map((r) => r.flaggedUri);
    const resolvedImpasse = resolved.filter((r) => r.resolved).map((r) => r.flaggedUri);
    const constraintPressure = ctx.selfModelEnabled
      ? await this.selfModelConstraintPressure(ctx.toolEvents)
      : this.constraintPressure(ctx.toolEvents);
    const cycleStatus: ReflectiveMarkerInput['cycleStatus'] =
      ctx.status === 'aborted'
        ? 'aborted'
        : resolvedImpasse.length > 0
          ? 'impasse-resolved'
          : 'completed';
    const noted =
      flaggedImpasse.length > 0
        ? `${flaggedImpasse.length} impasse(s) flagged, ${resolvedImpasse.length} auto-resolved.`
        : ctx.status === 'completed'
          ? 'Cycle completed; no impasse.'
          : 'Cycle aborted; core delegation threw.';

    await meta.writeMarker({
      cycleUri: ctx.cycleUri,
      cycleStatus,
      toolsUsed,
      toolErrors,
      emptyRetrieval: ctx.retrievalHits === 0,
      toolChurn: this.isToolChurn(ctx.toolEvents),
      constraintPressure,
      flaggedImpasse,
      resolvedImpasse,
      noted,
    });
  }

  /**
   * Map this cycle's observable signals to impasse inputs (F2, doc 08 §4):
   *  - a goal-conflict flagged by Phase 3;
   *  - every errored tool call (Phase 5 `tool-error`, or `tool-policy-denied-all`
   *    when the error class names a policy/permission denial);
   *  - an empty action selection (core finished with neither a reply nor a tool
   *    call), which only counts when the cycle itself completed.
   */
  private detectImpasses(ctx: {
    cycleUri: string;
    status: 'completed' | 'aborted';
    responseText?: string;
    toolEvents: ToolEpisodeEvent[];
    goalConflict: boolean;
    cycleId?: string;
    wmOverflow?: { dropped: number; capacity: number };
    userKey?: string;
  }): ImpasseInput[] {
    const out: ImpasseInput[] = [];
    // At most one wm-overflow per cycle, however many entries were dropped.
    if (ctx.wmOverflow) {
      out.push({
        kind: 'wm-overflow',
        flaggedInPhase: `${ctx.cycleUri}_3`,
        context: `Working memory at capacity ${ctx.wmOverflow.capacity}: ${ctx.wmOverflow.dropped} entry(ies) above salience ${OVERFLOW_SALIENCE} dropped.`,
        ...(ctx.cycleId ? { cycleId: ctx.cycleId } : {}),
        ...(ctx.userKey ? { forUser: ctx.userKey } : {}),
      });
    }
    if (ctx.goalConflict) {
      out.push({
        kind: 'goal-conflict',
        flaggedInPhase: `${ctx.cycleUri}_3`,
        context: 'More than one substantive goal active for the turn.',
      });
    }
    for (const e of ctx.toolEvents) {
      if (e.phase !== 'completed' || e.outcome !== 'error') continue;
      const denied = /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? '');
      const kind: ImpasseKind = denied ? 'tool-policy-denied-all' : 'tool-error';
      out.push({
        kind,
        flaggedInPhase: `${ctx.cycleUri}_5`,
        context: `${e.toolName}: ${e.errorClass ?? 'error'}`,
      });
    }
    const nothingHappened =
      ctx.status === 'completed' && !ctx.responseText && ctx.toolEvents.length === 0;
    if (nothingHappened) {
      out.push({
        kind: 'action-selection-empty',
        flaggedInPhase: `${ctx.cycleUri}_4`,
        context: 'Core produced neither a response nor a tool call.',
      });
    }
    return out;
  }

  /** Constraint pressure = count of policy/permission-denied tool errors. */
  private constraintPressure(toolEvents: ToolEpisodeEvent[]): number {
    return toolEvents.filter(
      (e) =>
        e.phase === 'completed' &&
        e.outcome === 'error' &&
        /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? ''),
    ).length;
  }

  /**
   * G3 — constraint pressure attributed from the self-model: an errored tool
   * call counts as pressure when a `cogt:Constraint` governs that tool (its
   * `cogt:applies` names the tool), the regex heuristic catches it, or both.
   * This makes the self-model's declared constraints, not just error strings,
   * the source of the metacognitive constraint-pressure signal.
   */
  private async selfModelConstraintPressure(toolEvents: ToolEpisodeEvent[]): Promise<number> {
    const sm = new SelfModel(this.triplestore, this.agentId);
    let pressure = 0;
    for (const e of toolEvents) {
      if (e.phase !== 'completed' || e.outcome !== 'error') continue;
      const heuristic = /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? '');
      const governed = (await sm.constraintsForTool(e.toolName)).length > 0;
      if (heuristic || governed) pressure++;
    }
    return pressure;
  }

  /** Tool churn = the same tool invoked three or more times in one cycle. */
  private isToolChurn(toolEvents: ToolEpisodeEvent[]): boolean {
    const counts = new Map<string, number>();
    for (const e of toolEvents) {
      if (e.phase !== 'called') continue;
      counts.set(e.toolName, (counts.get(e.toolName) ?? 0) + 1);
    }
    for (const n of counts.values()) if (n >= 3) return true;
    return false;
  }

  /**
   * E3 — back-fill the weak `userSatisfied` signal onto the *previous* cycle's
   * skill traces (doc 06 §3). The signal comes one cycle late: a fresh inbound
   * message is the user's reaction to the prior turn. The classifier is
   * intentionally crude — clear thanks/affirmation => true, clear
   * rejection/correction => false, anything ambiguous (incl. a topic change)
   * => null, which leaves `userSatisfied` unset.
   */
  private async backfillPriorSatisfaction(
    sessionId: string,
    cycleId: string,
    text: string,
  ): Promise<void> {
    const satisfied = this.classifySatisfaction(text);
    if (satisfied === null) return;
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const uris = await pm.findPriorCycleTraceUris(sessionId, cycleId);
    for (const uri of uris) await pm.backfillSatisfaction(uri, satisfied);
  }

  /** Crude satisfaction read of an inbound message: true / false / null (ambiguous). */
  private classifySatisfaction(text: string): boolean | null {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const positive =
      /\b(thanks|thank you|thx|danke|perfect|perfekt|great|super|awesome|nice|exactly|genau|correct|richtig|stimmt|spot on|works?|funktioniert|top)\b/.test(
        t,
      ) || /(^|\s)(👍|🙏|✅)/.test(text);
    const negative =
      /\b(no|nope|nein|wrong|falsch|incorrect|stop|stopp|not what|that'?s wrong|not right|nicht richtig|quatsch|leider nicht)\b/.test(
        t,
      ) || /(^|\s)(👎|❌)/.test(text);
    if (positive && !negative) return true;
    if (negative && !positive) return false;
    return null;
  }

  /**
   * E2 — one `cogt:SkillTrace` per tool call (gated by cog.flagProceduralMemory).
   * The traces reuse the C3 tool-event buffer, so no new live-path
   * instrumentation is needed. `called`/`completed` events are paired by
   * `callId`: the `called` event supplies the (keys-only, secret-free) args
   * brief, the `completed` event supplies outcome/duration/errorClass.
   *
   * Redaction: `toolArgsBrief` is already keys-only and `toolArgsHash` is the
   * FNV-1a of that keys-only brief, so no argument value reaches procedural
   * memory. `forGoal`/`forGoalType` come from this turn's active goal; the
   * sequence position/length and `previousTrace` link are derived from call
   * order so the consolidation job can later detect tool sequences.
   */
  private async writeSkillTraces(
    sessionId: string,
    cycleId: string,
    toolEvents: ToolEpisodeEvent[],
    activeGoalUri?: string,
    activeGoalType?: string,
  ): Promise<number> {
    // Pair events by callId, preserving first-seen order.
    interface Call {
      callId: string;
      toolName: string;
      argsBrief?: string;
      startedAt: Date;
      outcome?: 'success' | 'error';
      durationMs?: number;
      errorClass?: string;
    }
    const calls = new Map<string, Call>();
    const order: string[] = [];
    for (const ev of toolEvents) {
      let call = calls.get(ev.callId);
      if (!call) {
        call = { callId: ev.callId, toolName: ev.toolName, startedAt: ev.occurredAt };
        calls.set(ev.callId, call);
        order.push(ev.callId);
      }
      if (ev.phase === 'called') {
        call.startedAt = ev.occurredAt;
        if (ev.argsBrief !== undefined) call.argsBrief = ev.argsBrief;
      } else {
        call.outcome = ev.outcome;
        call.durationMs = ev.durationMs;
        call.errorClass = ev.errorClass;
      }
    }
    if (order.length === 0) return 0;

    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const sequenceLen = order.length;
    let previousTrace: string | undefined;
    let pos = 0;
    for (const callId of order) {
      const c = calls.get(callId)!;
      pos++;
      const brief = c.argsBrief ?? '';
      // No `completed` event => the call never resolved (e.g. aborted cycle);
      // a trace is still written per the DoD, recorded as a partial outcome.
      const outcome: TraceInput['outcome'] = c.outcome ?? 'partial';
      const trace: TraceInput = {
        toolName: c.toolName,
        toolArgsHash: fnv1aHex(brief),
        toolArgsBrief: brief,
        executedAt: c.startedAt,
        durationMs: c.durationMs ?? 0,
        outcome,
        errorClass: c.errorClass,
        forGoal: activeGoalUri,
        forGoalType: activeGoalType,
        cycleId,
        sessionId,
        sequencePos: pos,
        sequenceLen,
        previousTrace,
      };
      previousTrace = await pm.recordTrace(trace);
    }
    return order.length;
  }

  /** `core:privacyClass "secret"` for a payload that matches a credential shape. */
  private privacyOf(payload: string | undefined): { privacyClass?: 'secret' } {
    return looksLikeSecret(payload) ? { privacyClass: 'secret' } : {};
  }

  /**
   * C2 — append the `message-received` perception episode (actor = sender,
   * payload = text, transcriptRef = session). D4 — backfills the turn's active
   * goal when known.
   */
  private async appendInboundEpisode(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    occurredAt: Date,
    activeGoalUri?: string,
    perception?: Perception,
  ): Promise<string> {
    const channel = envelope.channel ? String(envelope.channel) : undefined;
    const actor = envelope.sender?.id
      ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
      : undefined;
    // Owner marker (the mandate gate reads it, docs §5.1): only a live,
    // human-facing turn from the verified owner carries it. Synthetic envelopes
    // (initiative, scheduler, cron trigger, webhooks) also claim isOwner and are
    // excluded by isHumanOwnerTurn.
    const actorIsOwner = isHumanOwnerTurn(envelope);
    return new EpisodicMemory(this.triplestore, this.agentId).append({
      episodeType: 'message-received',
      occurredAt,
      sessionId,
      cycleId,
      channel,
      actor,
      ...(actorIsOwner ? { actorIsOwner: true } : {}),
      forUser: cogUserKey(envelope.sender),
      ...this.privacyOf(envelope.text),
      payload: envelope.text || '',
      // Without a perception record (no hook ran) the episode is as before.
      // With one, the transcript reference carries the line index of the user
      // entry in the session JSONL (zero-based), e.g. `<session>.jsonl:line_12`.
      transcriptRef:
        perception?.transcriptLine !== undefined
          ? `${sessionId}.jsonl:line_${perception.transcriptLine}`
          : `${sessionId}.jsonl`,
      ...(perception
        ? {
            about: perception.about,
            tags: perception.tags,
            hasClaim: perception.hasClaim,
          }
        : {}),
      partOfGoal: activeGoalUri,
    });
  }

  /**
   * Write this turn's recall (Phase 2) onto the retrieval buffer, best first.
   * Each entry carries its score as `retrievalScore` (and as salience) and the
   * graph it was read from; the working memory stamps the sender's user key on
   * every entry.
   */
  /**
   * Attention and carry-over for one cycle (queued persist, conversational
   * turns). In order:
   *  1. carry the previous cycle's entries of this session and user into this
   *     cycle (selfBuffer, goal entries of goals still live, flagged notes),
   *     decayed ×0.7 and linked by `carriedFrom`, and mark that graph closed;
   *  2. apply the capacity to what the carry added;
   *  3. boost entries about the active goal's entities, damp stale carried
   *     entries, drop carried entries below the floor.
   * Best-effort: a failure goes to `onError` and never reaches the reply.
   */
  private async carryAndAttend(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    activeGoalUri: string | undefined,
    settings: AttentionSettings,
    goalsEnabled: boolean,
    wmOpts: WorkingMemoryOptions | undefined,
  ): Promise<void> {
    try {
      const userKey = cogUserKey(envelope.sender);
      // Scoping: the key holds session AND user, so a cycle never finds another
      // user's (or another session's) previous graph.
      const key = `${sessionId}\u0000${userKey}`;
      const prevCycleId = this.lastCycle.get(key);

      const liveGoals = new Set<string>();
      const boost = new Set<string>();
      const keep = new Set<string>();
      if (goalsEnabled) {
        const active = await new GoalStack(
          this.triplestore,
          this.registry,
          this.agentId,
          sessionId,
          undefined,
          this.viewerOf(envelope),
        ).active();
        // The implicit respond-to-user goal is a safety net, not something to hold in mind.
        for (const g of active) {
          if (g.goalType === RESPOND_TO_USER) continue;
          liveGoals.add(g.uri);
          for (const a of g.about ?? []) keep.add(a);
          if (g.uri === activeGoalUri) for (const a of g.about ?? []) boost.add(a);
        }
      }

      const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId, userKey, wmOpts);
      if (prevCycleId && prevCycleId !== cycleId) {
        const prev = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, prevCycleId, userKey);
        const carried = await prev.carryForward(cycleId, { liveGoals });
        if (carried > 0) await wm.enforce();
        await prev.markClosed();
      }
      await wm.attend({ boostEntities: boost, keepEntities: keep, theta: settings.theta });

      this.lastCycle.delete(key);
      this.lastCycle.set(key, cycleId);
      if (this.lastCycle.size > LAST_CYCLE_MAX) {
        const oldest = this.lastCycle.keys().next().value;
        if (oldest !== undefined) this.lastCycle.delete(oldest);
      }
    } catch (e) {
      this.onError?.(e);
    }
  }

  private async writeRecall(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    phaseUri: string,
    comprehension: ComprehensionResult,
    wmOpts?: WorkingMemoryOptions,
  ): Promise<void> {
    const wm = new WorkingMemory(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionId,
      cycleId,
      cogUserKey(envelope.sender),
      wmOpts,
    );
    for (const e of comprehension.entries) {
      // The working memory writes the reference as a bare IRI: only a safe one is kept.
      let refersTo: string | undefined = e.refersTo;
      try {
        sparqlIri(e.refersTo);
      } catch {
        refersTo = undefined;
      }
      await wm.write(
        {
          buffer: 'retrievalBuffer',
          entryKind: e.kind,
          payload: e.payload,
          salience: e.score,
          retrievalScore: e.score,
          sourceGraph: e.sourceGraph,
          ...(refersTo ? { refersTo } : {}),
        },
        phaseUri,
      );
    }
  }

  /** Write the goal and self entries produced for the prompt assembler (queued persist). */
  private async writeQueuedWm(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    phaseUri: string,
    entries: WMEntryInput[],
    wmOpts?: WorkingMemoryOptions,
  ): Promise<void> {
    const wm = new WorkingMemory(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionId,
      cycleId,
      cogUserKey(envelope.sender),
      wmOpts,
    );
    for (const e of entries) await wm.write(e, phaseUri);
  }

  /**
   * Shadow mode: store what the prompt assembler produced and how it differs
   * from the blocks actually sent, as a `cogt:PromptShadow` of the cycle. It
   * carries the cycle's `forUser`, like every record of the cycle.
   */
  private async writePromptShadow(
    sessionId: string,
    cycleUri: string,
    userKey: string,
    record: ShadowRecord,
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);
    const uri = `${cycleUri}_prompt`;
    const summary = JSON.stringify({
      diff: record.diff,
      cut: record.cut,
      droppedForeign: record.droppedForeign,
    });
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}PromptShadow> .`,
      `<${uri}> <${COGT}partOfCycle> <${cycleUri}> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
      `<${uri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}assembledText> "${escapeLiteral(record.assembledText)}" .`,
      `<${uri}> <${COGT}assembledTokens> "${Math.trunc(record.tokens)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}diffSummary> "${escapeLiteral(summary)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /**
   * Episodic memory writes (Phase C, C2 + the response half of C3).
   *
   *  - Phase 1 records a `message-received` episode (actor = sender, payload =
   *    text, transcriptRef = session) chained to the session's prior episode.
   *  - Phase 5 records a `response-sent` episode for the textual reply.
   *  - Phase 5 also records `tool-called` / `tool-completed` episodes for each
   *    tool the core invoked (C3), replayed here in arrival order so the
   *    narrative chain stays temporally correct.
   *
   * Recall is not done here: it happens once, before the answer (Phase 2,
   * Comprehension.ts).
   */
  private async writeEpisodes(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    startedAt: Date,
    endedAt: Date,
    responseText?: string,
    toolEvents: ToolEpisodeEvent[] = [],
    activeGoalUri?: string,
    inboundEpisodeUri?: string,
    perception?: Perception,
  ): Promise<void> {
    const em = new EpisodicMemory(this.triplestore, this.agentId);
    const channel = envelope.channel ? String(envelope.channel) : undefined;
    const userKey = cogUserKey(envelope.sender);

    // C2 — perception episode (already written ahead of the core on a
    // conversational turn; see runCycle).
    if (!inboundEpisodeUri) {
      await this.appendInboundEpisode(envelope, sessionId, cycleId, startedAt, activeGoalUri, perception);
    }

    // C3 — tool-called / tool-completed episodes, in arrival order.
    for (const ev of toolEvents) {
      if (ev.phase === 'called') {
        await em.append({
          episodeType: 'tool-called',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
          forUser: userKey,
          payload: ev.argsBrief ? `${ev.toolName} (${ev.argsBrief})` : ev.toolName,
          ...this.privacyOf(ev.argsBrief),
          tags: [ev.callId],
        });
      } else {
        await em.append({
          episodeType: 'tool-completed',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
          forUser: userKey,
          payload: `${ev.toolName} -> ${ev.outcome ?? 'unknown'}`,
          outcome: ev.outcome,
          durationMs: ev.durationMs,
          errorClass: ev.errorClass,
          tags: [ev.callId],
        });
      }
    }

    // C3 (response half) — response-sent episode.
    if (responseText) {
      await em.append({
        episodeType: 'response-sent',
        occurredAt: endedAt,
        sessionId,
        cycleId,
        channel,
        actor: `urn:${this.agentId}:self#${this.agentId}`,
        forUser: userKey,
        ...this.privacyOf(responseText),
        payload: responseText,
        transcriptRef: `${sessionId}.jsonl`,
        ...(perception ? { about: perception.about } : {}),
        partOfGoal: activeGoalUri,
      });
    }
  }

  /**
   * Initiative episode (docs/initiative-architecture.md §6). One episode per
   * unattended cycle recording the trigger (the synthetic envelope text), the
   * outcome (completed/aborted, whether a reply/notification was produced, how
   * many tools ran) and the triggering goal. This is the audit trail for what
   * the agent did while nobody was watching. Reuses EpisodicMemory, so it lands
   * in the same `cog:episodic` graph as every other episode.
   */
  private async writeInitiativeEpisode(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
    responseText: string | undefined,
    toolEvents: ToolEpisodeEvent[],
    goalUri?: string,
  ): Promise<void> {
    const em = new EpisodicMemory(this.triplestore, this.agentId);
    const toolCalls = new Set(
      toolEvents.filter((e) => e.phase === 'called').map((e) => e.callId),
    ).size;
    const outcome: 'success' | 'error' = status === 'completed' ? 'success' : 'error';
    const reason =
      status === 'aborted'
        ? 'initiative cycle aborted (core delegation threw)'
        : responseText
          ? 'initiative cycle completed with output'
          : toolCalls > 0
            ? 'initiative cycle completed with tool action(s)'
            : 'initiative cycle completed as a no-op';
    const trigger = (envelope.text || '').trim();
    const payload = `trigger: ${trigger || '(none)'} | outcome: ${reason} | tools: ${toolCalls}`;
    await em.append({
      episodeType: 'initiative',
      occurredAt: endedAt,
      sessionId,
      cycleId,
      channel: envelope.channel ? String(envelope.channel) : undefined,
      actor: `urn:${this.agentId}:self#${this.agentId}`,
      // Unattended work is the owner's: initiative episodes carry the owner's key.
      forUser: OWNER_USER_KEY,
      payload,
      outcome,
      partOfGoal: goalUri,
      salience: 0.8,
    });
  }

  /**
   * B5 — Phase 1 perception onto the perception buffer. With a perception record
   * its entries are written in order (message text, sender, channel, entities,
   * claims, intent); without one (initiative turns) the earlier three entries.
   */
  private async writePerception(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    phaseUri: string,
    perception?: Perception,
    wmOpts?: WorkingMemoryOptions,
  ): Promise<void> {
    const wm = new WorkingMemory(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionId,
      cycleId,
      cogUserKey(envelope.sender),
      wmOpts,
    );
    if (perception) {
      for (const entry of perception.entries) await wm.write(entry, phaseUri);
      return;
    }
    const text = envelope.text || '';
    if (text) {
      await wm.write(
        { buffer: 'perceptionBuffer', entryKind: 'message-text', payload: text, salience: 1.0 },
        phaseUri,
      );
    }
    if (envelope.sender?.id) {
      await wm.write(
        {
          buffer: 'perceptionBuffer',
          entryKind: 'sender-id',
          payload: envelope.sender.id,
          salience: 1.0,
        },
        phaseUri,
      );
    }
    if (envelope.channel) {
      await wm.write(
        {
          buffer: 'perceptionBuffer',
          entryKind: 'channel',
          payload: String(envelope.channel),
          salience: 0.6,
        },
        phaseUri,
      );
    }
  }

  /** B4 — reify the cycle and its six phases into cog:cycles:<sess>. */
  private async writeCycleAndPhases(
    sessionId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
    userKey: string,
    marks: PhaseMarks = { cycleStart: startedAt, coreEnd: endedAt },
    toolEvents: ToolEpisodeEvent[] = [],
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);

    const tStart = startedAt.toISOString();
    const tEnd = endedAt.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    const lines: string[] = [
      `<${cycleUri}> <${RDF_TYPE}> <${COGT}Cycle> .`,
      `<${cycleUri}> <${COGT}cycleStatus> "${status}" .`,
      `<${cycleUri}> <${COGT}startedAt> ${dt(tStart)} .`,
      `<${cycleUri}> <${COGT}endedAt> ${dt(tEnd)} .`,
      `<${cycleUri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
    ];

    // Phase boundaries come from instants measured in memory while the cycle
    // ran. Phase k spans [b[k-1], b[k]]:
    //   b0 cycle start          b1 perception record computed
    //   b2 goal hook started    b3 goal hook returned
    //   b4 last tool completed  b5 core returned      b6 now (records written)
    // Phase 1 therefore covers the context build and the perception compute;
    // Phase 2 is reserved (no work yet) and spans the gap to the goal hook;
    // Phase 4 ends with the last tool call (zero length on a turn without
    // tools), Phase 5 is the rest of the core, Phase 6 is the reflection write.
    // Boundaries are forced non-decreasing and the times are millisecond
    // resolution, so a phase that finishes within one millisecond has zero length.
    const lastToolDone = toolEvents
      .filter((e) => e.phase === 'completed')
      .reduce<Date | undefined>((m, e) => (!m || e.occurredAt > m ? e.occurredAt : m), undefined);
    const raw: Array<Date | undefined> = [
      marks.cycleStart,
      marks.perceivedAt,
      marks.goalStart,
      marks.goalEnd,
      lastToolDone,
      marks.coreEnd ?? endedAt,
      new Date(),
    ];
    const bounds: number[] = [];
    raw.forEach((d, i) => {
      const prev = i === 0 ? startedAt.getTime() : bounds[i - 1];
      bounds.push(Math.max(prev, d ? d.getTime() : prev));
    });
    // The tool completion must not run past the end of the core.
    bounds[4] = Math.min(bounds[4], bounds[5]);
    bounds[3] = Math.min(bounds[3], bounds[4]);
    const span = (ordinal: number): [string, string] => [
      new Date(bounds[ordinal - 1]).toISOString(),
      new Date(bounds[ordinal]).toISOString(),
    ];

    PHASE_KINDS.forEach((kind, i) => {
      const ordinal = i + 1;
      const phaseUri = `${cycleUri}_${ordinal}`;
      const [s, e] = span(ordinal);
      lines.push(`<${cycleUri}> <${COGT}hasPhase> <${phaseUri}> .`);
      lines.push(`<${phaseUri}> <${RDF_TYPE}> <${COGT}Phase> .`);
      lines.push(`<${phaseUri}> <${COGT}partOfCycle> <${cycleUri}> .`);
      lines.push(`<${phaseUri}> <${COGT}phaseKind> "${escapeLiteral(kind)}" .`);
      lines.push(`<${phaseUri}> <${COGT}ordinal> "${ordinal}"^^<${XSD}integer> .`);
      lines.push(`<${phaseUri}> <${COGT}startedAt> ${dt(s)} .`);
      lines.push(`<${phaseUri}> <${COGT}endedAt> ${dt(e)} .`);
    });

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /** B6 — Phase 6 reflection: a ReflectiveMarker into cog:meta. */
  private async writeReflectiveMarker(
    cycleUri: string,
    status: 'completed' | 'aborted',
  ): Promise<void> {
    const graph = GraphUriResolver.getCogMetaGraph(this.agentId);
    this.registry.assertWritable(graph);

    const markerUri = `urn:${this.agentId}:cog:marker:${newId()}`;
    const note =
      status === 'completed'
        ? 'Cycle completed; response delegated to runtime core.'
        : 'Cycle aborted; core delegation threw.';
    const lines = [
      `<${markerUri}> <${RDF_TYPE}> <${COGT}ReflectiveMarker> .`,
      `<${markerUri}> <${COGT}reflectsOn> <${cycleUri}> .`,
      `<${markerUri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${markerUri}> <${COGT}noted> "${escapeLiteral(note)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }
}
