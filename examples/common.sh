# Shared helpers for the Ontofelia example recipes.
# Sourced by each recipe's run.sh — not meant to be executed directly.
#
# Configuration (environment variables):
#   ONTOFELIA_URL    Gateway base URL   (default: http://127.0.0.1:18780)
#   ONTOFELIA_TOKEN  Gateway API token  (default: read from ~/.ontofelia/ontofelia.json5)
#   ONTOFELIA_AGENT  Agent id used in Named Graph IRIs, urn:<agent>:worldview etc.
#                    (default: ontofelia, the primary agent)

ONTOFELIA_URL="${ONTOFELIA_URL:-http://127.0.0.1:18780}"
ONTOFELIA_AGENT="${ONTOFELIA_AGENT:-ontofelia}"

if [ -z "${ONTOFELIA_TOKEN:-}" ]; then
  _config_file="$HOME/.ontofelia/ontofelia.json5"
  if [ -f "$_config_file" ]; then
    # The config is JSON5 (comments, unquoted keys), so a tolerant regex is
    # the simplest way to pull out gateway.token without extra dependencies.
    ONTOFELIA_TOKEN="$(python3 - "$_config_file" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"""token\s*:\s*['"]([^'"]+)['"]""", text)
print(m.group(1) if m else "", end="")
PY
)"
  fi
fi

if [ -z "${ONTOFELIA_TOKEN:-}" ]; then
  echo "error: no gateway token." >&2
  echo "Set ONTOFELIA_TOKEN, or make sure ~/.ontofelia/ontofelia.json5 exists (run: ontofelia onboard)." >&2
  exit 1
fi

# api METHOD PATH [JSON_BODY] — authenticated request against the gateway.
# Extra curl arguments can be passed through the _API_CURL_ARGS array (used by
# sparql below); it is empty for every other caller.
_API_CURL_ARGS=()
api() {
  if [ $# -ge 3 ] && [ -n "$3" ]; then
    curl -sS ${_API_CURL_ARGS[@]+"${_API_CURL_ARGS[@]}"} -X "$1" "$ONTOFELIA_URL$2" \
      -H "Authorization: Bearer $ONTOFELIA_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$3"
  else
    curl -sS ${_API_CURL_ARGS[@]+"${_API_CURL_ARGS[@]}"} -X "$1" "$ONTOFELIA_URL$2" \
      -H "Authorization: Bearer $ONTOFELIA_TOKEN"
  fi
}

require_gateway() {
  if ! curl -sS -m 5 "$ONTOFELIA_URL/api/health" >/dev/null 2>&1; then
    echo "error: no gateway reachable at $ONTOFELIA_URL" >&2
    echo "Start it with: ontofelia gateway start" >&2
    exit 1
  fi
}

# Semantic ingestion parses every message with the LLM. The mock provider
# (configured by `ontofelia onboard --non-interactive`) cannot do that, so
# with provider "mock" no triples are ever written — refuse honestly.
require_real_provider() {
  local name
  name="$(api GET /api/provider | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("name",""), end="")
except Exception: print("", end="")')"
  if [ -z "$name" ] || [ "$name" = "mock" ]; then
    echo "error: the gateway is running with the '${name:-unknown}' provider." >&2
    echo "These recipes need a real LLM provider (fact extraction runs through the LLM)." >&2
    echo "See examples/README.md — 'You need a real LLM provider'." >&2
    exit 1
  fi
  echo "[provider: $name]"
}

# chat "message" — send one chat message; prints the agent's reply.
# All chat() calls in one script share a session (SESSION_ID).
SESSION_ID="${SESSION_ID:-}"
chat() {
  local payload response
  payload="$(python3 -c 'import json,sys
body = {"message": sys.argv[1]}
if len(sys.argv) > 2 and sys.argv[2]:
    body["sessionId"] = sys.argv[2]
print(json.dumps(body), end="")' "$1" "$SESSION_ID")"
  echo ">> $1"
  response="$(api POST /api/chat "$payload")"
  SESSION_ID="$(printf '%s' "$response" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("sessionId",""), end="")
except Exception: print("", end="")')"
  printf '%s' "$response" | python3 -c 'import json,sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print(raw); sys.exit(1)
if "error" in data:
    print("chat error: " + str(data["error"])); sys.exit(1)
print(data.get("text", ""))'
  echo
}

# show_graph ROLE [NEEDLE] — dump a Named Graph (as Turtle) from the
# knowledge graph, optionally filtered to statement blocks that mention
# NEEDLE (case-insensitive). Roles: user, worldview, claims, evidence,
# conflicts, inferred, schema, self, ...
show_graph() {
  api GET /api/knowledge/graphs | python3 -c '
import json, sys
role, needle = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
data = json.load(sys.stdin)
for g in data.get("graphs", []):
    if g.get("role") != role:
        continue
    uri, count = g.get("uri"), g.get("tripleCount")
    print(f"--- graph {uri} ({count} triples) ---")
    turtle = g.get("turtle") or ""
    if not needle:
        print(turtle.strip() or "(empty)")
        continue
    # Group the Turtle into statement blocks (a block ends at a line
    # terminated by "."). Keep every block whose subject also appears in a
    # block mentioning the needle, so e.g. a whole Claim node is shown when
    # only its claimSubject line matches.
    blocks, cur = [], []
    for line in turtle.splitlines():
        cur.append(line)
        if line.rstrip().endswith("."):
            blocks.append("\n".join(cur))
            cur = []
    if cur:
        blocks.append("\n".join(cur))
    blocks = [b for b in blocks if b.strip() and not b.lstrip().startswith("@prefix")]
    subject = lambda b: b.split(None, 1)[0]
    wanted = {subject(b) for b in blocks if needle.lower() in b.lower()}
    hits = [b for b in blocks if subject(b) in wanted]
    hits.sort(key=lambda b: (subject(b), b))
    if hits:
        print("\n".join(hits))
    else:
        print(f"(no statements mentioning {needle!r})")
' "$1" "${2:-}"
  echo
}

# sparql QUERY — run a read-only SELECT/ASK against POST /api/knowledge/sparql
# and print the result as a table. Every triple pattern must sit inside a
# GRAPH <iri> { ... } pattern; user and session graphs are refused (403).
# On an HTTP error the status and the server's message are printed to stderr
# and the function returns 1.
sparql() {
  local payload raw
  payload="$(python3 -c 'import json,sys
print(json.dumps({"query": sys.argv[1]}), end="")' "$1")"
  _API_CURL_ARGS=(-w $'\n%{http_code}')
  raw="$(api POST /api/knowledge/sparql "$payload")" || { _API_CURL_ARGS=(); return 1; }
  _API_CURL_ARGS=()
  local rc=0
  printf '%s' "$raw" | python3 -c '
import json, sys
raw = sys.stdin.read()
body, _, status = raw.rpartition("\n")
PREFIXES = [
    ("urn:ontofelia:entity:", "entity:"),
    ("urn:ontofelia:core#", "core:"),
    ("urn:shared:ontology#", "onto:"),
    ("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:"),
    ("http://www.w3.org/2000/01/rdf-schema#", "rdfs:"),
    ("http://www.w3.org/2001/XMLSchema#", "xsd:"),
]
def short(cell):
    value = cell.get("value", "")
    if cell.get("type") == "uri":
        for prefix, name in PREFIXES:
            if value.startswith(prefix):
                return name + value[len(prefix):]
    return value.replace("\n", " ")
try:
    data = json.loads(body)
except Exception:
    data = None
if not status.startswith("2"):
    msg = data.get("error") if isinstance(data, dict) else None
    detail = msg or body.strip() or "(empty response)"
    print(f"sparql error: HTTP {status}: {detail}", file=sys.stderr)
    sys.exit(1)
if not isinstance(data, dict):
    print(f"sparql error: HTTP {status}: unreadable response: {body.strip()}", file=sys.stderr)
    sys.exit(1)
if data.get("type") == "boolean":
    print("true" if data.get("boolean") else "false")
    sys.exit(0)
variables, rows = data.get("variables", []), data.get("bindings", [])
if not rows:
    print("(no rows)")
    sys.exit(0)
table = [[short(r[v]) if v in r else "" for v in variables] for r in rows]
widths = [max(len(v), *(len(row[i]) for row in table)) for i, v in enumerate(variables)]
line = lambda cells: "  ".join(c.ljust(w) for c, w in zip(cells, widths)).rstrip()
print(line(variables))
print(line(["-" * w for w in widths]))
for row in table:
    print(line(row))
if data.get("truncated"):
    print("(truncated: more rows matched than the endpoint returns)")
' || rc=$?
  echo
  return "$rc"
}
