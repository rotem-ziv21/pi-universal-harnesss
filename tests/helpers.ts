import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLog } from "../src/decide/decision-log.ts";
import { createGates, type GatesConfig } from "../src/decide/gates.ts";
import { createJevClient, type QuestionSet } from "../src/decide/jev.ts";

/**
 * A stand-in for the decisions endpoint. `answer` receives the state and the
 * question ids and returns a probability (noul) or an option (choice) per id.
 */
export type Responder = (state: any, questions: QuestionSet) => Record<string, number | string> | "fail";

export interface FakeJev {
	fetchImpl: typeof fetch;
	calls: Array<{ state: any; questions: QuestionSet }>;
}

export function fakeJev(respond: Responder): FakeJev {
	const calls: FakeJev["calls"] = [];
	const fetchImpl = (async (_url: string, init: { body: string }) => {
		const body = JSON.parse(init.body) as { state: unknown; questions: QuestionSet };
		calls.push({ state: body.state, questions: body.questions });
		const result = respond(body.state, body.questions);
		if (result === "fail") return new Response("upstream error", { status: 503 });
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(body.questions)) {
			const value = result[id];
			if (q.type === "noul") answers[id] = { type: "noul", noul: typeof value === "number" ? value : 0.05 };
			else {
				const choice = typeof value === "string" ? value : Object.keys(q.criteria).at(-1)!;
				answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 };
			}
		}
		return new Response(JSON.stringify({ model: "typesafe/jev-test", answers, usage: { input_tokens: 100 } }), { status: 200 });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

export const DEFAULT_GATES: GatesConfig = {
	mode: "enforce",
	action: { destructiveConfirm: 0.8, exfiltrationBlock: 0.8, outwardConfirm: 0.85, offRequestConfirm: 0.9 },
	done: { enabled: true, claimsDone: 0.7, applies: 0.5, maxNudgesPerPrompt: 1, maxNudgesPerSession: 3 },
	stuckThreshold: 3,
};

export function makeGates(respond: Responder, overrides: Partial<GatesConfig> = {}, options: { key?: string | undefined } = { key: "sk-test" }) {
	const jev = fakeJev(respond);
	const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
	const log = createDecisionLog(join(dir, "decisions.jsonl"));
	const client = createJevClient({
		config: { enabled: true, baseUrl: "https://example.test/api", decisionsPath: "/alpha/decisions", model: "~typesafe/jev-latest", timeoutMs: 2000 },
		getApiKey: async () => options.key,
		fetchImpl: jev.fetchImpl,
	});
	const gates = createGates({ config: { ...DEFAULT_GATES, ...overrides }, jev: client, log, cwd: "/work/project" });
	return { gates, jev, log, dir };
}
