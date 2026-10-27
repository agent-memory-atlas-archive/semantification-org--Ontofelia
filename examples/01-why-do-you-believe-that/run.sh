#!/usr/bin/env bash
# Recipe 01 — "Why do you believe that?"
# Teach the agent one fact, then show the claim/evidence chain that
# the knowledge graph keeps for it. See README.md in this directory.
set -euo pipefail
cd "$(dirname "$0")"
source ../common.sh

require_gateway
require_real_provider
echo

echo "== 1. Teach the agent a fact =="
chat "Please remember: Ada Marlowe is a person, and she works at Helios Robotics."

echo "== 2. Ask the agent to justify its belief (reply is LLM-dependent) =="
chat "Why do you believe that Ada Marlowe works at Helios Robotics?"

# Step 3 reads the fact through the read-only SPARQL endpoint
# (POST /api/knowledge/sparql). Every triple pattern sits inside an explicit
# GRAPH <iri>. The endpoint serves only graphs that hold no private user data:
# user, session, claims, evidence and the cognitive graphs are refused (403)
# because they carry other users' messages. A third party such as Ada lands in
# the agent's worldview graph, which is served.
WORLDVIEW="urn:$ONTOFELIA_AGENT:worldview"

echo "== 3. The fact itself — real RDF triples in the worldview graph =="
sparql "SELECT ?subject ?predicate ?object WHERE {
  GRAPH <$WORLDVIEW> {
    ?subject ?predicate ?object .
    FILTER(CONTAINS(STR(?subject), \"Ada\"))
  }
} ORDER BY ?predicate"

# Steps 4 and 5 use the operator's graph dump (GET /api/knowledge/graphs), not
# SPARQL: claims and evidence mix every user's data, so the SPARQL endpoint
# refuses them.
echo "== 4. The claim behind the fact — status, confidence, timestamps =="
show_graph claims Ada

echo "== 5. The evidence — the exact utterance the fact was learned from =="
show_graph evidence Ada

echo "Done. Every fact in Ontofelia's memory is auditable like this."
