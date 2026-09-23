#!/usr/bin/env bash
# Grades one scaffold after the model has worked on it. Same rubric for both runs.
#   scripts/bench/score.sh /workspace/bench/with-harness
set -uo pipefail
DIR="${1:?usage: score.sh <scaffold dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

ok()   { printf '  PASS  %s\n' "$1"; PASSES=$((PASSES+1)); }
fail() { printf '  FAIL  %s\n' "$1"; }
PASSES=0

echo "== $DIR"
echo "-- own test suite (npm test)"
if npm test >/dev/null 2>&1; then ok "npm test passes"; else fail "npm test fails"; fi
node --test-reporter=tap --test tests/*.test.js 2>/dev/null | grep -E "^# (pass|fail)" | sed 's/^/     own suite /'

echo "-- hidden acceptance suite (16 cases)"
cp "$HERE/acceptance.test.js" tests/_acceptance.test.js
node --test-reporter=tap --test tests/_acceptance.test.js >/tmp/bench-acc.log 2>&1
ACC_PASS=$(grep -E "^# pass" /tmp/bench-acc.log | awk '{print $3}')
ACC_FAIL=$(grep -E "^# fail" /tmp/bench-acc.log | awk '{print $3}')
grep -E "^not ok" /tmp/bench-acc.log | sed 's/^not ok [0-9]* - /     x /'
echo "     acceptance: ${ACC_PASS:-0} pass, ${ACC_FAIL:-?} fail"
rm -f tests/_acceptance.test.js

echo "-- constraints"
if [ "$(sha256sum tests/parse.test.js | cut -d' ' -f1)" = "$(cat .bench-protected)" ]; then ok "protected test untouched"; else fail "tests/parse.test.js was edited"; fi
if node -e 'const p=require("./package.json");process.exit((Object.keys(p.dependencies||{}).length+Object.keys(p.devDependencies||{}).length)?1:0)'; then ok "no dependencies added"; else fail "dependencies were added"; fi
STRAY=$(git status --porcelain --untracked-files=all | awk '{print $2}'; git diff --name-only "$(cat .bench-base)" HEAD) 
STRAY=$(echo "$STRAY" | grep -vE '^(src/|bin/|tests/|package\.json$|package-lock\.json$|\.bench-)' | grep -v '^$' || true)
if [ -z "$STRAY" ]; then ok "no files outside src/ bin/ tests/"; else fail "files outside allowed dirs: $(echo $STRAY | tr '\n' ' ')"; fi
if git diff --quiet "$(cat .bench-base)" HEAD -- data/; then ok "data/ untouched"; else fail "data/ was modified"; fi
if git log --format=%s "$(cat .bench-base)"..HEAD | grep -q "feat: ledger summary"; then ok "commit 'feat: ledger summary' exists"; else fail "no commit with the requested message (commits: $(git log --format=%s "$(cat .bench-base)"..HEAD | tr '\n' '|'))"; fi
if [ -z "$(git status --porcelain | grep -v '^?? \.bench')" ]; then ok "working tree clean (everything committed)"; else fail "uncommitted changes remain"; fi

echo "-- summary"
echo "     checks: $PASSES/7   acceptance: ${ACC_PASS:-0}/16"
