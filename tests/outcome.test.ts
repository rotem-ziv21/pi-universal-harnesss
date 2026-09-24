import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createJevClient } from "../src/decide/jev.ts";
import { judgeOutcome } from "../src/decide/policy.ts";
import { outcomeQuestions } from "../src/decide/questions.ts";
import { splitRequestItems } from "../src/decide/request-items.ts";

const SHORTY = `Build a small HTTP URL shortener called \`shorty\` in this directory, using only Node.js built-ins. No npm packages.

Deliverables:

1. \`src/store.js\` exporting \`createStore({ now })\`.
   - \`now\` is a function returning the current time in ms. Default to \`Date.now\`.
   - \`store.add(url, ttlMs)\` returns a 6-character code.

2. \`src/server.js\` exporting \`createServer(store)\` which returns a \`node:http\` server.

3. \`bin/shorty.js\` that starts the server on the port from the \`PORT\` environment variable.

4. \`package.json\` with \`"type": "module"\` and a \`test\` script.

5. Tests in \`tests/\`. \`npm test\` must pass.

6. A git repository with a single commit \`feat: shorty url shortener\` containing everything.

Constraints: ES modules only. No dependencies or devDependencies in package.json.`;

describe("request items", () => {
	it("a numbered request becomes its lead sentence, its numbered items with their sub-bullets, and the trailing constraints", () => {
		const items = splitRequestItems(SHORTY);
		assert.equal(items.length, 8, items.join("\n"));
		assert.match(items[0]!, /^Build a small HTTP URL shortener/);
		assert.match(items[1]!, /^`src\/store\.js` exporting.*`now` is a function.*6-character code/);
		assert.match(items[6]!, /single commit/);
		assert.match(items[7]!, /^Constraints: ES modules only/);
		assert.ok(!items.some((i) => /^Deliverables:?$/.test(i)), "a header is not an item");
	});
	it("bullets and plain sentences work too", () => {
		assert.deepEqual(splitRequestItems("- add a README\n- add a LICENSE file"), ["add a README", "add a LICENSE file"]);
		assert.deepEqual(splitRequestItems("Fix the parser bug. Do not touch the config files."), ["Fix the parser bug.", "Do not touch the config files."]);
		assert.deepEqual(splitRequestItems("Fix the parser bug"), ["Fix the parser bug"]);
		assert.deepEqual(splitRequestItems("   "), []);
	});
	it("one question pair per item, the item in its own field, the question text fixed", () => {
		const q = outcomeQuestions(["add a README", "add a LICENSE file"]);
		assert.deepEqual(Object.keys(q), ["item_0_done", "item_0_checked", "item_1_done", "item_1_checked", "claim_beyond_evidence", "completeness"]);
		const first = q.item_0_done!;
		assert.equal(first.type, "noul");
		assert.deepEqual(Object.keys(first.instructions as object), ["item", "question"]);
		assert.equal((first.instructions as { item: string }).item, "add a README");
		assert.equal((q.item_1_done!.instructions as { question: string }).question, (first.instructions as { question: string }).question);
	});
});

describe("outcome policy", () => {
	const t = { claimsDone: 0.7, applies: 0.5, itemDone: 0.8, itemNotDone: 0.2, claimBeyond: 0.7 };
	const noul = (p: number) => ({ type: "noul" as const, p });
	const items = ["a", "b", "c"];

	it("counts in code: shown, not shown, uncertain, unchecked", () => {
		const v = judgeOutcome(
			{ item_0_done: noul(0.95), item_0_checked: noul(0.9), item_1_done: noul(0.1), item_1_checked: noul(0.1), item_2_done: noul(0.5), item_2_checked: noul(0.5), claim_beyond_evidence: noul(0.8) },
			items, t, true,
		);
		assert.deepEqual([v.done, v.missing, v.uncertain, v.unchecked], [["a"], ["b"], ["c"], []]);
		assert.equal(v.status, "unverified");
		assert.equal(v.claimBeyond, 0.8);
	});
	it("all shown and checked is verified; all shown but one unchecked is partial", () => {
		const all = { item_0_done: noul(0.9), item_0_checked: noul(0.9), item_1_done: noul(0.9), item_1_checked: noul(0.9), item_2_done: noul(0.9), item_2_checked: noul(0.9), claim_beyond_evidence: noul(0.1) };
		assert.equal(judgeOutcome(all, items, t, true).status, "verified");
		assert.equal(judgeOutcome({ ...all, item_2_checked: noul(0.2) }, items, t, true).status, "partial");
		assert.equal(judgeOutcome({ ...all, item_2_checked: noul(0.2) }, items, t, false).status, "verified", "when checks do not apply, unchecked does not count");
	});
	it("a score answer is read with its level, distribution and confidence", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ model: "jev", answers: { completeness: { type: "score", score: 3.2, probabilities: [0, 0.05, 0.1, 0.6, 0.25], confidence: 0.61 } } }), { status: 200 })) as unknown as typeof fetch;
		const client = createJevClient({ config: { enabled: true, baseUrl: "https://x.test", decisionsPath: "/d", model: "m", timeoutMs: 1000 }, getApiKey: async () => "k", fetchImpl });
		const result = await client.ask({}, { completeness: { type: "score", instructions: "how much", criteria: ["0", "1", "2", "3", "4"] } });
		assert.ok(result.ok);
		const answer = result.answers.completeness!;
		assert.ok(answer.type === "score" && answer.score === 3.2 && answer.confidence === 0.61 && answer.probabilities[3] === 0.6);
	});
});
