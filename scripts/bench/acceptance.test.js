import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Lazy imports: a missing module fails its own cases, not the whole file.
const missing = (name) => () => { throw new Error(`${name} is missing or does not export the function`); };
const parseTransactions = (await import("../src/parse.js").catch(() => ({}))).parseTransactions ?? missing("src/parse.js");
const summarize = (await import("../src/ledger.js").catch(() => ({}))).summarize ?? missing("src/ledger.js");

const H = "date,category,amount\n";
const cli = (args) => spawnSync(process.execPath, ["bin/ledger.js", ...args], { encoding: "utf8" });
const tmp = (name, body) => {
	const dir = mkdtempSync(join(tmpdir(), "ledger-"));
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
};

test("A1 decimals are kept", () => {
	assert.equal(parseTransactions(`${H}2024-01-05,groceries,12.50\n`).transactions[0].amount, 12.5);
});
test("A2 trailing newline adds no row and is not counted as skipped", () => {
	const r = parseTransactions(`${H}2024-01-05,groceries,3\n`);
	assert.equal(r.transactions.length, 1);
	assert.equal(r.skipped, 0);
});
test("A3 header row is not a transaction", () => {
	assert.equal(parseTransactions(H).transactions.length, 0);
});
test("A4 a row with the wrong column count is skipped and counted", () => {
	const r = parseTransactions(`${H}2024-01-05,groceries\n2024-01-06,rent,10\n`);
	assert.equal(r.transactions.length, 1);
	assert.equal(r.skipped, 1);
});
test("A5 a non-numeric amount is skipped and counted", () => {
	const r = parseTransactions(`${H}2024-01-05,groceries,abc\n`);
	assert.equal(r.transactions.length, 0);
	assert.equal(r.skipped, 1);
});
test("A6 whitespace around fields is trimmed", () => {
	const t = parseTransactions(`${H} 2024-01-05 , groceries , 7 \n`).transactions[0];
	assert.equal(t.date, "2024-01-05");
	assert.equal(t.category, "groceries");
	assert.equal(t.amount, 7);
});
test("A7 refunds reduce the month total", () => {
	const { months } = summarize([
		{ date: "2024-01-05", category: "groceries", amount: 10 },
		{ date: "2024-01-06", category: "groceries", amount: -2.5 },
	]);
	assert.equal(months[0].total, 7.5);
});
test("A8 months are grouped by YYYY-MM and sorted ascending", () => {
	const { months } = summarize([
		{ date: "2024-03-01", category: "a", amount: 1 },
		{ date: "2024-01-15", category: "a", amount: 1 },
		{ date: "2024-01-20", category: "a", amount: 1 },
	]);
	assert.deepEqual(months.map((m) => m.month), ["2024-01", "2024-03"]);
	assert.equal(months[0].total, 2);
});
test("A9 topCategory is the category with the highest total in the month", () => {
	const { months } = summarize([
		{ date: "2024-01-01", category: "groceries", amount: 30 },
		{ date: "2024-01-02", category: "groceries", amount: 30 },
		{ date: "2024-01-03", category: "rent", amount: 50 },
	]);
	assert.equal(months[0].topCategory, "groceries");
});
test("A10 totals are rounded to two decimals", () => {
	const { months } = summarize([
		{ date: "2024-01-01", category: "a", amount: 0.1 },
		{ date: "2024-01-02", category: "a", amount: 0.2 },
	]);
	assert.equal(months[0].total, 0.3);
});
test("A11 empty input gives no months", () => {
	assert.deepEqual(summarize([]), { months: [] });
});
test("A12 CLI --json prints the summarize result", () => {
	const r = cli(["summary", "data/sample.csv", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.deepEqual(out.months.map((m) => m.month), ["2024-01", "2024-02"]);
	assert.equal(out.months[0].total, 1261);
	assert.equal(out.months[0].topCategory, "rent");
	assert.equal(out.months[1].total, 1255);
});
test("A13 CLI plain output mentions each month", () => {
	const r = cli(["summary", "data/sample.csv"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("2024-01") && r.stdout.includes("2024-02"));
});
test("A14 CLI on a header-only file prints 'no transactions' and exits 0", () => {
	const r = cli(["summary", tmp("empty.csv", H)]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(/no transactions/i.test(r.stdout));
});
test("A15 CLI on a missing file exits 1 with an error on stderr", () => {
	const r = cli(["summary", "/nonexistent/none.csv"]);
	assert.equal(r.status, 1);
	assert.ok(r.stderr.trim().length > 0);
});
test("A16 CLI reports skipped rows on stderr", () => {
	const r = cli(["summary", tmp("bad.csv", `${H}2024-01-05,groceries,1\nbroken\n`)]);
	assert.equal(r.status, 0);
	assert.ok(/skipped 1/i.test(r.stderr), r.stderr);
});
