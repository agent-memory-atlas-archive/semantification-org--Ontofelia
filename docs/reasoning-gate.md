# Reasoning gate

On a large knowledge graph, storing a fact is dominated by the OWL
materialization that runs before the insert: the reasoner reads the whole ABox
twice (with and without the new fact) for every fact. The **reasoning gate**
lets the owner trade a little consistency for latency: above a size they
choose, `storeFact` skips that synchronous step and a background **catch-up**
rebuilds the inferred graphs later.

**It is off by default.** Without the setting, Ontofelia behaves exactly as
before: every stored fact is materialized synchronously.

Measurements (gate off vs on, up to 12 000 facts) are in
[`bench/BENCHMARK_RESULTS.md`](../bench/BENCHMARK_RESULTS.md), section H.

## The setting

| Key | Value | Default | Effect |
|---|---|---|---|
| `reasoning/asyncThreshold` | integer >= 1 | absent (off) | Number of triples in the graphs the reasoner would read for the fact (the "ABox"). A fact stored while that count is **above** the threshold is not materialized synchronously. |

- **Where it lives.** One triple on `urn:<agent>:setup:reasoning` in the setup
  graph `urn:<agent>:setup`, predicate `urn:shared:ontology#reasoning/asyncThreshold`.
  This is the same home as the cognitive-layer setup keys: the engine reads it
  on every store, so a change needs no restart, and only the owner can write
  that graph. (The gateway config file is not used: the knowledge engine has no
  access to it, and a change there would need a restart.)
- **What is counted.** The triples of the graphs the reasoner reads for that
  fact: the worldview for a worldview fact, the worldview plus the user's own
  graph for a private fact. The TBox is not counted (it is fixed and small).
  The count is a single `COUNT` over the in-memory store, far cheaper than the
  Turtle dump and two reasoner runs it avoids. A rough guide: the benchmark
  layout holds about 17 triples per fact in all graphs, of which 4 are in the
  worldview.
- **Unusable values are "off".** Absent, `0`, negative, fractional or
  unparseable means never skip; so does a failed read or count. A broken
  setting never thins out the reasoning.

Set it with the owner API or CLI (no restart):

```bash
ontofelia reasoning gate                      # show the setting and the state
ontofelia reasoning gate --threshold 20000    # skip above 20 000 ABox triples
ontofelia reasoning gate --off                # back to the default
```

`GET /api/reasoning/gate` returns `{ asyncThreshold, staleSince, catchUpRunning }`;
`PUT /api/reasoning/gate` with `{ "asyncThreshold": 20000 }` (or `null` / `0`
for off) sets it. Both need the gateway token like every `/api/*` route.

## What happens above the threshold

1. `storeFact` writes a durable **stale marker** (`reasoning/inferredStale`, an
   `xsd:dateTime`, on the same setup subject). If the marker cannot be written,
   the fact is materialized synchronously after all.
2. It logs one line (gateway log, level info):
   `reasoning gate: skipped synchronous materialization (agent=... graph=... abox-triples=... threshold=...)`.
3. The fact itself, its claim and its evidence are stored as usual. Only its
   derivations (the inferred triples) are deferred.

The marker is written once per stale period, not once per fact (every write to
the store costs a durable flush).

## The catch-up

`KnowledgeEngine.catchUpInferredGraphs` rebuilds **every** inferred graph of
the agent (the shared one and each user's) from the facts with the existing
`rebuildInferredGraphs` path, then clears the marker. It

- runs only when the marker is set (or when forced), so a run with nothing
  stale is a no-op;
- never runs concurrently with itself for one agent (a second call returns
  `busy`);
- clears the marker only if no fact was skipped while it ran; otherwise the
  marker stays and the next run covers those facts. While a catch-up runs,
  newly stored facts are deferred the same way, whatever the threshold, so a
  synchronous materialization cannot race the rebuild;
- on a failure keeps the marker (the next run retries) and logs a warning.

**Trigger.** The gateway registers a cron job `reasoning.catchup`, every five
minutes (`*/5 * * * *`). Its interval is the job's own cron expression: change
or disable it with the existing cron API (`/api/cron`). The job calls the
engine directly (no agent session is opened).

**Run it now.** `ontofelia reasoning catchup` (add `--force` to rebuild even
when nothing is marked stale), or `POST /api/reasoning/catchup[?force=true]`.
The response is `{ status, shared, perUser, stillStale, staleSince }` with
`status` one of `ran`, `not-stale`, `busy`, `unavailable` (no in-process
reasoner, e.g. Fuseki) or `failed`.

## Trade-off: eventual consistency of inferred triples

While the marker is set, the inferred graphs (`urn:<agent>:inferred` and
`urn:<agent>:inferred:user:<id>`) may be **missing** the derivations of the
facts stored since the gate first skipped, and, because the rebuild clears each
graph before refilling it, may be briefly empty or partial while a catch-up
runs. Anything that reads the inferred graphs (recall, `memory_sparql` on an
inferred graph, queries that rely on subclass, subproperty, symmetric,
transitive or inverse closure) can therefore answer with less than the full
closure until the next catch-up finishes, by default within about five minutes.
Asserted facts are never affected: they are always stored and read at once.

Retractions already rebuild the affected inferred graph on their own and are
unchanged.

## What the rebuild produces

The catch-up reuses the repair path the project already had, so its result is
the complete closure of the stored facts, which is not byte-for-byte what
on-write materialization leaves behind:

- the rebuild does not store the reasoner's `X a owl:Thing` bookkeeping triples
  (it never did); on-write materialization does;
- the rebuild also derives what the type assertion of a new entity implies
  (for example `X a core:Entity` from `X a core:Person`). The type assertion
  that `storeFact` writes for a new entity is not materialized on write, so
  on-write materialization never records those triples;
- a triple that was first derived and later asserted is kept in the inferred
  graph by on-write materialization but is not listed again by the rebuild.

Everything else matches: the tests store the same facts with the gate off and
on, run the catch-up and compare the inferred graphs triple by triple.

## Cost

The catch-up reasons over the whole graph at once, so one run costs roughly one
or two synchronous materializations and needs about as much memory as one
gate-off store at the same size (see the benchmark). It runs at most once per
interval and only when something was skipped, instead of once per fact. If the
gateway process is close to its memory limit at that graph size, size the
threshold and the interval with that peak in mind.
