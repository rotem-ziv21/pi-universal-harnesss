#!/usr/bin/env bash
# Print the commands a live task actually ran, as corpus entries to review and
# paste into tests/corpus/commands.json. Blocked ones are marked so a false block
# can be recorded as expect: "allow" once it is understood.
#   scripts/bench/corpus-from-task.sh ~/.pi/agent/harness/tasks/<task-id> "shorty 4"
set -euo pipefail
DIR="${1:?task directory}"; FROM="${2:-live run}"
python3 - "$DIR/events.jsonl" "$FROM" <<'PY'
import json, sys
events = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
blocked = {e["payload"]["actionId"] for e in events if e["type"] == "tool_blocked"}
seen = set()
for e in events:
    if e["type"] != "tool_proposed": continue
    a = e["payload"]["action"]
    if a["toolName"] != "bash": continue
    cmd = a.get("input", {}).get("command") or a["summary"].removeprefix("bash: ")
    if cmd in seen: continue
    seen.add(cmd)
    entry = {"tool": "bash", "command": cmd, "expect": "allow", "from": sys.argv[2] + (" (was blocked)" if a["id"] in blocked else "")}
    print(json.dumps(entry, ensure_ascii=False) + ",")
PY
