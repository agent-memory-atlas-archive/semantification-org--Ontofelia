# 01 — "Why do you believe that?"

**What this shows:** every fact Ontofelia learns is stored as a real RDF triple
*plus* a **Claim** (status, confidence, timestamps) *plus* **Evidence** — the
exact utterance the fact came from. Ask the agent why it believes something and
it can answer from that chain instead of guessing.

**Time:** ~2 minutes. **Prerequisites:** running gateway + a real LLM provider
— see [`examples/README.md`](../README.md).

## Run it

```bash
./run.sh
```

Or step by step:

## Walkthrough

Set up the connection (skip if `ONTOFELIA_URL`/`ONTOFELIA_TOKEN` are already set):

```bash
export ONTOFELIA_URL=http://127.0.0.1:18780
export ONTOFELIA_TOKEN="$(sed -n "s/.*token: '\([^']*\)'.*/\1/p" ~/.ontofelia/ontofelia.json5)"
```

**1. Teach the agent a fact:**

```bash
curl -s "$ONTOFELIA_URL/api/chat" \
  -H "Authorization: Bearer $ONTOFELIA_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Please remember: Ada Marlowe is a person, and she works at Helios Robotics."}'
```

**2. Ask it to justify the belief:**

```bash
curl -s "$ONTOFELIA_URL/api/chat" \
  -H "Authorization: Bearer $ONTOFELIA_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Why do you believe that Ada Marlowe works at Helios Robotics?"}'
```

Reply from a real run (output will vary — LLM-dependent):

> I believe that Ada Marlowe works at Helios Robotics based on the information
> you provided. The fact was accepted with high confidence (0.95) from your
> statement: "Ada Marlowe is a person, and she works at Helios Robotics."

That answer is not confabulated — the agent called its `memory_explain` tool
and read the claim from the graph.

**3. Look at the graph yourself.** The gateway has a read-only SPARQL endpoint,
`POST /api/knowledge/sparql` (see [`docs/api.md`](../../docs/api.md)). It accepts
only `SELECT` and `ASK`, requires every triple pattern to sit inside an explicit
`GRAPH <iri> { ... }`, and serves only graphs that hold no private user data
(the shared vocabulary, `urn:<agent>:worldview`, `schema`, `inferred`, `self`,
`skills`). Everything else is refused with `403`: the per-user and per-session
graphs, and also `claims`, `evidence`, `conflicts` and the cognitive graphs,
because those collect the messages of every user. The agent id is `ontofelia`
unless you set `ONTOFELIA_AGENT`. The `sparql` helper in `common.sh` posts the
query and prints the result as a table (IRIs shortened: `entity:` is
`urn:ontofelia:entity:`, `core:` is `urn:ontofelia:core#`):

```bash
source ../common.sh

# the fact itself: the triples about Ada in the worldview graph
sparql 'SELECT ?subject ?predicate ?object WHERE {
  GRAPH <urn:ontofelia:worldview> {
    ?subject ?predicate ?object .
    FILTER(CONTAINS(STR(?subject), "Ada"))
  }
} ORDER BY ?predicate'
```

Output shape (the model may phrase predicates differently, so your rows can
vary):

```
subject             predicate     object
------------------  ------------  ----------------------
entity:Ada_Marlowe  rdf:type      entity:Person
entity:Ada_Marlowe  rdfs:label    Ada Marlowe
entity:Ada_Marlowe  core:worksAt  entity:Helios_Robotics
```

The claim and the evidence live in graphs the SPARQL endpoint does not serve.
As the operator you read them with the graph dump `GET /api/knowledge/graphs`;
the shared helper filters it:

```bash
show_graph claims Ada       # the claim: status, confidence, timestamps
show_graph evidence Ada     # the evidence: the exact source utterance
```

From the same run (claim and evidence IDs will differ):

```
--- graph urn:ontofelia:claims (29 triples) ---
<urn:claim:...> a <urn:shared:ontology#Claim> ;
  claimSubject   <urn:ontofelia:entity:Ada_Marlowe> ;
  claimPredicate <urn:ontofelia:core#worksAt> ;
  claimObject    <urn:ontofelia:entity:Helios_Robotics> ;
  confidence     "0.95" ; confidenceLabel "high" ; status "accepted" ;
  learnedAt      "2026-07-03T11:50:24.661Z" ;
  hasEvidence    <urn:evidence:...> ;
  sourceSpan     "Ada Marlowe is a person, and she works at Helios Robotics." .

--- graph urn:ontofelia:evidence (5 triples) ---
<urn:evidence:...> a <urn:shared:ontology#Evidence> ;
  evidenceType "message-span" ;
  rawText "Ada Marlowe is a person, and she works at Helios Robotics." ;
  capturedAt "2026-07-03T11:50:24.658Z" .
```

(The API returns one triple per line; the block above is condensed for
readability. `run.sh` shows the raw form. Facts about *you* are written to your
private user graph, which neither endpoint path is meant for; that is why this
recipe teaches the agent a fact about a third party.)

## What just happened

When your message arrived, Ontofelia's semantic ingestion parsed it with the
LLM, resolved "Ada Marlowe" to an entity URI, matched "works at" to the
ontology property `onto:worksAt`, and wrote three linked things: the **triple**
(worldview graph), a **Claim** about that triple (claims graph), and the
**Evidence** — your literal sentence (evidence graph). A vector store can tell
you *what text is similar*; this tells you *why a specific belief is held,
since when, and on whose word*.

Next: [02 — Contradiction detected](../02-contradiction-detected/) — what
happens when you tell the agent something that clashes with what it believes.
