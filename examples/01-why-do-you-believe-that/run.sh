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

# Steps 3-5 read the graph through the read-only SPARQL endpoint
# (POST /api/knowledge/sparql). Every triple pattern sits inside an explicit
# GRAPH <iri>; user and session graphs are not readable there. A third party
# such as Ada lands in the agent's worldview graph, its claim in the claims
# graph and its evidence in the evidence graph (urn:<agent>:<role>).
WORLDVIEW="urn:$ONTOFELIA_AGENT:worldview"
CLAIMS="urn:$ONTOFELIA_AGENT:claims"
EVIDENCE="urn:$ONTOFELIA_AGENT:evidence"

echo "== 3. The fact itself — real RDF triples in the worldview graph =="
sparql "SELECT ?subject ?predicate ?object WHERE {
  GRAPH <$WORLDVIEW> {
    ?subject ?predicate ?object .
    FILTER(CONTAINS(STR(?subject), \"Ada\"))
  }
} ORDER BY ?predicate"

echo "== 4. The claim behind the fact — status, confidence, timestamps =="
sparql "PREFIX onto: <urn:shared:ontology#>
SELECT ?predicate ?object ?status ?confidence ?confidenceLabel ?learnedAt WHERE {
  GRAPH <$CLAIMS> {
    ?claim a onto:Claim ;
           onto:claimSubject ?subject ;
           onto:claimPredicate ?predicate ;
           onto:claimObject ?object ;
           onto:status ?status ;
           onto:confidence ?confidence ;
           onto:confidenceLabel ?confidenceLabel ;
           onto:learnedAt ?learnedAt .
    FILTER(CONTAINS(STR(?subject), \"Ada\"))
  }
} ORDER BY ?predicate"

echo "== 5. The evidence — the exact utterance the fact was learned from =="
sparql "PREFIX onto: <urn:shared:ontology#>
SELECT ?predicate ?evidenceType ?rawText ?capturedAt WHERE {
  GRAPH <$CLAIMS> {
    ?claim onto:claimSubject ?subject ;
           onto:claimPredicate ?predicate ;
           onto:hasEvidence ?evidence .
    FILTER(CONTAINS(STR(?subject), \"Ada\"))
  }
  GRAPH <$EVIDENCE> {
    ?evidence onto:evidenceType ?evidenceType ;
              onto:rawText ?rawText ;
              onto:capturedAt ?capturedAt .
  }
} ORDER BY ?predicate"

echo "Done. Every fact in Ontofelia's memory is auditable like this."
