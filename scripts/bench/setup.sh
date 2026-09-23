#!/usr/bin/env bash
# Creates two identical scaffolds for an A/B run of the same development task:
#   <root>/with-harness     run with the harness enabled
#   <root>/without-harness  run after `/harness disable` + /reload
# Each is a git repo with an initial commit, a buggy parser, one protected failing
# test and a sample data file. Grade both with scripts/bench/score.sh <dir>.
set -euo pipefail
ROOT="${1:-/workspace/bench}"
HERE="$(cd "$(dirname "$0")" && pwd)"

scaffold() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir/src" "$dir/tests" "$dir/data" "$dir/bin"
  cat > "$dir/package.json" <<'JSON'
{
  "name": "ledger",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "node --test tests/*.test.js" }
}
JSON
  cat > "$dir/README.md" <<'MD'
# ledger

Tiny transaction ledger. Input is a CSV with a header row:

    date,category,amount
    2024-01-05,groceries,42.10
    2024-01-09,rent,1200
    2024-02-01,groceries,-5.00

`amount` is a decimal number. Negative amounts are refunds.
Run the tests with `npm test`.
MD
  cat > "$dir/src/parse.js" <<'JS'
/**
 * Parse a ledger CSV (see README) into transactions.
 * Returns { transactions, skipped } where `skipped` counts malformed rows.
 */
export function parseTransactions(text) {
	const lines = text.split("\n");
	const transactions = [];
	for (const line of lines.slice(1)) {
		const [date, category, amount] = line.split(",");
		transactions.push({ date, category, amount: parseInt(amount) });
	}
	return { transactions, skipped: 0 };
}
JS
  cat > "$dir/tests/parse.test.js" <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTransactions } from "../src/parse.js";

test("amounts keep their decimals", () => {
	const { transactions } = parseTransactions("date,category,amount\n2024-01-05,groceries,12.50\n");
	assert.equal(transactions.length, 1);
	assert.equal(transactions[0].amount, 12.5);
});

test("a trailing newline does not produce an extra row", () => {
	const { transactions, skipped } = parseTransactions("date,category,amount\n2024-01-05,groceries,3\n");
	assert.equal(transactions.length, 1);
	assert.equal(skipped, 0);
});
JS
  cat > "$dir/data/sample.csv" <<'CSV'
date,category,amount
2024-01-05,groceries,42.10
2024-01-09,rent,1200
2024-01-20,groceries,18.90
2024-02-01,groceries,-5.00
2024-02-03,transport,60
2024-02-14,rent,1200
CSV
  printf 'node_modules/\n' > "$dir/.gitignore"
  ( cd "$dir" && git init -q && git add -A && git -c user.name=bench -c user.email=bench@example.com commit -qm "chore: scaffold" )
  sha256sum "$dir/tests/parse.test.js" | cut -d' ' -f1 > "$dir/.bench-protected"
  ( cd "$dir" && git rev-parse HEAD > .bench-base )
}

scaffold "$ROOT/with-harness"
scaffold "$ROOT/without-harness"
cp "$HERE/TASK.md" "$ROOT/TASK.md"
echo "Scaffolds ready:"
echo "  $ROOT/with-harness"
echo "  $ROOT/without-harness"
echo "Task text: $ROOT/TASK.md"
