import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createModelContractReviewer } from "../src/contract/reviewer.ts";
import { droppedHardUserItems, lock, revise } from "../src/contract/revisions.ts";
import { createDeterministicJudge } from "../src/judges/deterministic.ts";
import { isStale } from "../src/judges/judge.ts";
import { createOpenRouterJevJudge } from "../src/judges/openrouter-jev.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createStubModelAdapter } from "../src/models/model-adapter.ts";
import { completeStructured } from "../src/models/structured.ts";
import { checkUserLimits, createProgressMonitor, parseNumericLimit } from "../src/progress/monitor.ts";
import { createStateManager, restoreStateManager } from "../src/state/state-manager.ts";
import { contradicts } from "../src/state/freshness.ts";
import { HarnessError } from "../src/util/errors.ts";
import { Type } from "typebox";
import { action, brokenJudge, choiceAnswer, contract, fakeFetch, noulAnswer, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

/** §61 — the failure modes the harness exists to survive. */

const config = testConfig();

describe("Contract compilation and review failures", () => {
	test("the reviewer catches a requirement the compiler dropped", async () => {
		const adapter = createStubModelAdapter(() =>
			JSON.stringify({
				verdict: "REVISE",
				findings: [
					{
						kind: "missing_user_requirement",
						severity: "high",
						detail: "The user said 'only push if everything is safe' but no critical action covers publishing.",
					},
				],
				questions: [],
			}),
		);

		const review = await createModelContractReviewer(adapter).review({
			request: "Fix the bug. Only push if everything is safe.",
			contract: contract(),
		});

		assert.equal(review.verdict, "REVISE");
		assert.equal(review.findings[0]?.kind, "missing_user_requirement");
	});

	test("a PASS verdict alongside a high-severity finding is upgraded to REVISE", async () => {
		// Models do this regularly. The findings are substance; the verdict is a label.
		const adapter = createStubModelAdapter(() =>
			JSON.stringify({
				verdict: "PASS",
				findings: [{ kind: "fabricated_user_requirement", severity: "high", detail: "r2 is attributed to the user but was never said." }],
				questions: [],
			}),
		);

		const review = await createModelContractReviewer(adapter).review({ request: "x", contract: contract() });
		assert.equal(review.verdict, "REVISE", "the verdict must follow the findings, not contradict them");
	});

	test("NEEDS_USER_INPUT with no questions degrades to REVISE", async () => {
		const adapter = createStubModelAdapter(() => JSON.stringify({ verdict: "NEEDS_USER_INPUT", findings: [], questions: [] }));
		const review = await createModelContractReviewer(adapter).review({ request: "x", contract: contract() });
		assert.equal(review.verdict, "REVISE");
	});

	test("structured output survives prose wrapping and markdown fences", async () => {
		const schema = Type.Object({ goal: Type.String() });
		const adapter = createStubModelAdapter(
			() => 'Sure! Here is the contract you asked for:\n\n```json\n{"goal": "do the thing"}\n```\n\nLet me know if you need changes.',
		);

		const result = await completeStructured<{ goal: string }>(adapter, {
			systemPrompt: "x",
			userPrompt: "y",
			schema,
		});
		assert.equal(result.value.goal, "do the thing");
	});

	test("an invalid document is repaired, and the repair prompt keeps the original request", async () => {
		const schema = Type.Object({ goal: Type.String(), count: Type.Number() });
		const prompts: string[] = [];
		let attempt = 0;

		const adapter = createStubModelAdapter((request) => {
			prompts.push(request.userPrompt);
			attempt++;
			return attempt === 1 ? '{"goal": "x", "count": "not a number"}' : '{"goal": "x", "count": 3}';
		});

		const result = await completeStructured<{ goal: string; count: number }>(adapter, {
			systemPrompt: "x",
			userPrompt: "ORIGINAL TASK TEXT",
			schema,
		});

		assert.equal(result.value.count, 3);
		assert.equal(result.attempts, 2);
		assert.ok(prompts[1]?.includes("ORIGINAL TASK TEXT"), "the repair prompt must restate the task, or the model invents content");
	});

	test("a model that never produces valid output fails loudly rather than silently", async () => {
		const schema = Type.Object({ goal: Type.String() });
		const adapter = createStubModelAdapter(() => "I'm sorry, I can't help with that.");

		await assert.rejects(
			() => completeStructured(adapter, { systemPrompt: "x", userPrompt: "y", schema, maxRepairAttempts: 1 }),
			(e: unknown) => e instanceof HarnessError && e.code === "MODEL_OUTPUT_INVALID",
		);
	});
});

describe("Contract revision failures", () => {
	test("a revision may not silently drop a hard user constraint", () => {
		const before = lock(
			contract({
				constraints: [{ id: "c1", description: "Do not touch production", source: "user", priority: "hard" }],
			}),
		);
		const after = contract({ constraints: [] });

		const dropped = droppedHardUserItems(before, after);
		assert.deepEqual(dropped, ["Do not touch production"]);
	});

	test("the state manager refuses such a revision unless the user authorized it", () => {
		const c = contract({
			constraints: [{ id: "c1", description: "Do not touch production", source: "user", priority: "hard" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const stripped = contract({ constraints: [] });

		assert.throws(
			() => state.reviseContract(stripped, { reason: "cleanup", source: "compiler" }),
			(e: unknown) => e instanceof HarnessError && e.code === "CONTRACT_INVALID",
		);

		// The same revision is allowed when the user asked for it.
		const revision = state.reviseContract(stripped, { reason: "user withdrew the restriction", source: "user" });
		assert.equal(revision.toVersion, 2);
	});

	test("a locked contract cannot be mutated in place", () => {
		const locked = lock(contract({ requirements: [{ id: "r1", description: "x", source: "user", priority: "hard", status: "pending" }] }));
		assert.throws(() => {
			(locked.requirements[0] as { priority: string }).priority = "soft";
		}, TypeError);
	});

	test("a revision records a field-level diff", () => {
		const before = lock(contract({ goal: "old goal" }));
		const { contract: after, revision } = revise(
			before,
			{ ...contract({ goal: "new goal" }) },
			{ reason: "the user restated the goal", source: "user" },
		);

		assert.equal(after.version, 2);
		assert.equal(revision.fromVersion, 1);
		assert.ok(revision.changes.some((c) => c.field === "goal" && c.before === "old goal" && c.after === "new goal"));
	});
});

describe("Judge failures", () => {
	test("a stale decision is rejected rather than applied", () => {
		const decision = {
			decision: "PASS" as const,
			confidence: 1,
			reasons: [],
			missingEvidence: [],
			stateVersion: 41,
			judgeId: "x",
		};
		assert.equal(isStale(decision, 43), true);
		assert.equal(isStale(decision, 41), false);
	});

	test("a missing API key is reported as JUDGE_AUTH_MISSING, not as a network error", async () => {
		const judge = createOpenRouterJevJudge({ config: config.judge, apiKey: undefined });
		assert.equal(await judge.isAvailable(), false);

		await assert.rejects(
			() =>
				judge.evaluate({
					state: {} as never,
					requirements: [],
					constraints: [],
					checkpointType: "external_mutation",
					stateVersion: 1,
				}),
			(e: unknown) => e instanceof HarnessError && e.code === "JUDGE_AUTH_MISSING",
		);
	});

	test("HTTP 404 explains that the alpha decisions path may have moved", async () => {
		const judge = createOpenRouterJevJudge({
			config: { ...config.judge, maxRetries: 0 },
			apiKey: "sk-or-v1-test",
			fetchImpl: fakeFetch(() => ({ status: 404, body: "not found" })),
		});

		await assert.rejects(
			() => judge.evaluate({ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 }),
			(e: unknown) =>
				e instanceof HarnessError && e.code === "JUDGE_MODEL_UNAVAILABLE" && e.message.includes("decisionsPath"),
		);
	});

	test("a rate limit is retried, then surfaces as JUDGE_RATE_LIMITED", async () => {
		let calls = 0;
		const judge = createOpenRouterJevJudge({
			config: { ...config.judge, maxRetries: 2 },
			apiKey: "sk-or-v1-test",
			fetchImpl: fakeFetch(() => {
				calls++;
				return { status: 429, body: "rate limited" };
			}),
		});

		await assert.rejects(
			() => judge.evaluate({ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 }),
			(e: unknown) => e instanceof HarnessError && e.code === "JUDGE_RATE_LIMITED",
		);
		assert.equal(calls, 3, "should attempt once plus two retries");
	});

	test("a malformed response is rejected rather than half-interpreted", async () => {
		const judge = createOpenRouterJevJudge({
			config: { ...config.judge, maxRetries: 0 },
			apiKey: "sk-or-v1-test",
			fetchImpl: fakeFetch(() => ({ body: { model: "jev", nonsense: true } })),
		});

		await assert.rejects(
			() => judge.evaluate({ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 }),
			(e: unknown) => e instanceof HarnessError && e.code === "JUDGE_BAD_RESPONSE",
		);
	});

	test("a critical checkpoint fails closed when every Judge is down and there is no UI", async () => {
		const router = createJudgeRouter({
			primary: brokenJudge(new HarnessError("JUDGE_UNREACHABLE", "network down")),
			fallbacks: [brokenJudge(new HarnessError("MODEL_UNAVAILABLE", "no model"), "model")],
			config: config.judge,
			// No requestUserReview: simulates print/JSON mode.
		});

		const decision = await router.evaluate(
			{ state: { proposedAction: "publish" } as never, requirements: [], constraints: [], checkpointType: "external_mutation", stateVersion: 5 },
			"critical",
		);

		assert.equal(decision.decision, "FAIL", "a critical action must never be allowed without a decision");
		assert.equal(decision.degraded, true);
		assert.equal(decision.attempts.length, 2);
	});

	test("a critical checkpoint asks the user when a UI exists", async () => {
		let asked = false;
		const router = createJudgeRouter({
			primary: brokenJudge(new HarnessError("JUDGE_TIMEOUT", "timed out")),
			fallbacks: [],
			config: config.judge,
			requestUserReview: async () => {
				asked = true;
				return true;
			},
		});

		const decision = await router.evaluate(
			{ state: { proposedAction: "publish" } as never, requirements: [], constraints: [], checkpointType: "external_mutation", stateVersion: 5 },
			"critical",
		);

		assert.equal(asked, true);
		assert.equal(decision.decision, "PASS");
		assert.ok(decision.reasons[0]?.includes("approved"));
	});

	test("the fallback chain is used before the failure policy applies", async () => {
		const fallback = scriptedJudge(() => ({ decision: "PASS", confidence: 0.95 }), { id: "fallback" });

		const router = createJudgeRouter({
			primary: brokenJudge(new HarnessError("JUDGE_UNREACHABLE", "down")),
			fallbacks: [fallback],
			config: config.judge,
		});

		const decision = await router.evaluate(
			{ state: {} as never, requirements: [], constraints: [], checkpointType: "external_mutation", stateVersion: 1 },
			"critical",
		);

		assert.equal(decision.judgeId, "fallback");
		assert.equal(decision.degraded, true);
		assert.equal(fallback.calls.length, 1);
	});

	test("a user abort is not treated as a Judge failure", async () => {
		const fallback = scriptedJudge(() => ({ decision: "PASS" }), { id: "fallback" });
		const router = createJudgeRouter({
			primary: brokenJudge(new HarnessError("ABORTED", "user pressed Esc")),
			fallbacks: [fallback],
			config: config.judge,
		});

		await assert.rejects(
			() =>
				router.evaluate(
					{ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 },
					"critical",
				),
			(e: unknown) => e instanceof HarnessError && e.code === "ABORTED",
		);
		assert.equal(fallback.calls.length, 0, "an abort must not cascade through the fallback chain");
	});

	test("the deterministic Judge never returns PASS on a critical checkpoint", async () => {
		const judge = createDeterministicJudge({ config: config.judge });

		const decision = await judge.evaluate({
			state: { evidence: [{ requirement: "r1 satisfied", type: "t", source: "s", result: "ok", observedAt: "now" }] } as never,
			requirements: [{ id: "r1", description: "r1 satisfied", priority: "hard" }],
			constraints: [],
			checkpointType: "external_mutation",
			stateVersion: 1,
		});

		assert.equal(decision.decision, "REVIEW");
	});

	test("the deterministic Judge reports missing evidence for unproven hard requirements", async () => {
		const judge = createDeterministicJudge({ config: config.judge });

		const decision = await judge.evaluate({
			state: { evidence: [] } as never,
			requirements: [{ id: "r1", description: "tests pass", priority: "hard" }],
			constraints: [],
			checkpointType: "completion_claim",
			stateVersion: 1,
		});

		assert.equal(decision.decision, "MORE_EVIDENCE");
		assert.equal(decision.missingEvidence.length, 1);
	});
});

describe("Judge decision normalization", () => {
	const jevJudge = (answers: Record<string, unknown>) =>
		createOpenRouterJevJudge({
			config: config.judge,
			apiKey: "sk-or-v1-test",
			fetchImpl: fakeFetch(() => ({ body: { model: "jev", answers, usage: { input_tokens: 10, output_tokens: 2 } } })),
		});

	const query = {
		state: {} as never,
		requirements: [{ id: "r1", description: "tests pass", priority: "hard" as const }],
		constraints: [{ id: "c1", description: "do not touch production" }],
		checkpointType: "external_mutation",
		stateVersion: 7,
	};

	test("a violated hard constraint overrides a PASS verdict", async () => {
		const judge = jevJudge({
			verdict: choiceAnswer("PASS", { PASS: 0.8, FAIL: 0.1, MORE_EVIDENCE: 0.05, REVIEW: 0.05 }, 0.8),
			req_r1: noulAnswer(0.95),
			con_c1: noulAnswer(0.91),
		});

		const decision = await judge.evaluate(query);
		assert.equal(decision.decision, "FAIL", "nothing outranks a hard constraint violation");
		assert.ok(decision.reasons.some((r) => r.includes("Overriding")));
	});

	test("a PASS with an unsupported hard requirement becomes MORE_EVIDENCE", async () => {
		const judge = jevJudge({
			verdict: choiceAnswer("PASS", { PASS: 0.9, FAIL: 0.1 }, 0.9),
			req_r1: noulAnswer(0.2),
			con_c1: noulAnswer(0.01),
		});

		const decision = await judge.evaluate(query);
		assert.equal(decision.decision, "MORE_EVIDENCE");
		assert.equal(decision.missingEvidence.length, 1);
		assert.ok(decision.missingEvidence[0]?.includes("r1"));
	});

	test("a low-confidence PASS is downgraded to REVIEW", async () => {
		const judge = jevJudge({
			verdict: choiceAnswer("PASS", { PASS: 0.4, REVIEW: 0.35, FAIL: 0.25 }, 0.4),
			req_r1: noulAnswer(0.9),
			con_c1: noulAnswer(0.02),
		});

		const decision = await judge.evaluate(query);
		assert.equal(decision.decision, "REVIEW");
	});

	test("a clean PASS survives", async () => {
		const judge = jevJudge({
			verdict: choiceAnswer("PASS", { PASS: 0.95, FAIL: 0.05 }, 0.93),
			req_r1: noulAnswer(0.92),
			con_c1: noulAnswer(0.01),
		});

		const decision = await judge.evaluate(query);
		assert.equal(decision.decision, "PASS");
		assert.equal(decision.stateVersion, 7);
		assert.ok(decision.detail?.requirementSupport?.r1 === 0.92);
	});

	test("the request uses the decisions endpoint with the documented body shape", async () => {
		const fetchImpl = fakeFetch(() => ({
			body: { model: "jev", answers: { verdict: choiceAnswer("PASS", { PASS: 1 }, 0.99), req_r1: noulAnswer(0.9), con_c1: noulAnswer(0) } },
		}));

		await createOpenRouterJevJudge({ config: config.judge, apiKey: "sk-or-v1-test", fetchImpl }).evaluate(query);

		const call = fetchImpl.calls[0]!;
		assert.ok(call.url.endsWith("/alpha/decisions"), `expected the decisions endpoint, got ${call.url}`);

		const body = call.body as { model: string; state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };
		assert.equal(body.model, "~typesafe/jev-latest");
		assert.equal(body.questions.verdict?.type, "choice");
		assert.equal(body.questions.req_r1?.type, "noul");
		assert.equal(body.questions.con_c1?.type, "noul");

		// OpenRouter rejects null choice criteria, so every option must carry a string.
		const criteria = body.questions.verdict?.criteria as Record<string, unknown>;
		for (const value of Object.values(criteria)) {
			assert.equal(typeof value, "string");
			assert.notEqual(value, null);
		}
	});
});

describe("Evidence contradictions and freshness", () => {
	test("contradicting evidence supersedes rather than deletes", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const base = {
			requirementIds: ["r1"],
			type: "http_probe",
			sourceType: "api" as const,
			source: "GET /health",
			freshnessClass: "temporary" as const,
			trust: "runtime_evidence" as const,
		};

		state.addEvidence({ ...base, id: "evd-1", summary: "HTTPS unavailable", observedAt: "2026-01-01T00:00:00Z", stateVersion: 1 });
		state.addEvidence({ ...base, id: "evd-2", summary: "HTTPS available", observedAt: "2026-01-01T00:05:00Z", stateVersion: 2 });

		const evidence = state.getState().evidence;
		assert.equal(evidence.length, 2, "history must be preserved");
		assert.equal(evidence.find((e) => e.id === "evd-1")?.supersededBy, "evd-2");
		assert.equal(evidence.find((e) => e.id === "evd-2")?.supersededBy, undefined);
	});

	test("contradiction detection requires the same subject", () => {
		const base = {
			id: "a",
			requirementIds: ["r1"],
			observedAt: "now",
			stateVersion: 1,
			freshnessClass: "temporary" as const,
			trust: "runtime_evidence" as const,
			sourceType: "api" as const,
		};

		assert.equal(
			contradicts({ ...base, type: "probe", source: "GET /health", summary: "up" }, { ...base, id: "b", type: "probe", source: "GET /health", summary: "down" }),
			true,
		);
		// Different sources are not contradictions; they are two facts about two things.
		assert.equal(
			contradicts({ ...base, type: "probe", source: "GET /health", summary: "up" }, { ...base, id: "b", type: "probe", source: "GET /ready", summary: "down" }),
			false,
		);
	});
});

describe("Hypotheses are not facts (§18)", () => {
	test("a fact cannot be verified without supporting evidence", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		assert.throws(
			() =>
				state.verifyFact({
					id: "f1",
					statement: "SQL injection confirmed",
					evidenceIds: [],
					observedAt: new Date().toISOString(),
					freshnessClass: "persistent",
				}),
			(e: unknown) => e instanceof HarnessError && e.code === "INTERNAL",
		);
	});

	test("a fact cannot reference evidence that does not exist", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		assert.throws(() =>
			state.verifyFact({
				id: "f1",
				statement: "x",
				evidenceIds: ["evd-nonexistent"],
				observedAt: new Date().toISOString(),
				freshnessClass: "persistent",
			}),
		);
	});

	test("a model claim becomes a hypothesis, structurally distinct from a fact", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const hypothesis = state.addHypothesis({
			id: "h1",
			statement: "possible input-handling vulnerability",
			confidence: 0.6,
			status: "open",
			createdAt: new Date().toISOString(),
			supportingEvidenceIds: [],
			contradictingEvidenceIds: [],
			source: "model",
		});

		assert.equal(state.getState().hypotheses.length, 1);
		assert.equal(state.getState().verifiedFacts.length, 0, "a hypothesis must never land among the facts");
		assert.equal(hypothesis.status, "open");
	});
});

describe("Progress and user-defined limits (§43)", () => {
	test("a user limit is parsed into a countable unit", () => {
		assert.deepEqual(parseNumericLimit("After 10 loops, stop."), { value: 10, unit: "turns" });
		assert.deepEqual(parseNumericLimit("stop after 3 attempts"), { value: 3, unit: "attempts" });
		assert.equal(parseNumericLimit("be careful"), undefined);
	});

	test("a user limit stops the branch; a harness heuristic only advises", () => {
		const withLimit = contract({
			constraints: [{ id: "c1", description: "Stop after 2 attempts", source: "user", priority: "hard" }],
		});
		const state = createStateManager(withLimit.id, withLimit, { persist: false });
		state.lockContract(withLimit);

		const repeated = action("bash", { command: "make build" });
		for (let i = 0; i < 2; i++) {
			state.recordProposedAction({
				id: `a${i}`,
				toolName: "bash",
				summary: "build",
				signature: repeated.signature,
				at: new Date().toISOString(),
				stateVersion: state.getVersion(),
				outcome: "failed",
			});
		}

		const observation = checkUserLimits(withLimit, state.getState());
		assert.equal(observation?.action, "STOP_BRANCH");
		assert.equal(observation?.contractItemId, "c1");
		assert.ok(observation?.reason.includes("hard limit"));
	});

	test("repeating an action that always fails stops the branch", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const monitor = createProgressMonitor({ config });

		const repeated = action("bash", { command: "make build" });
		for (let i = 0; i < 3; i++) {
			state.recordProposedAction({
				id: `a${i}`,
				toolName: "bash",
				summary: "build",
				signature: repeated.signature,
				at: new Date().toISOString(),
				stateVersion: state.getVersion(),
				outcome: "failed",
			});
		}

		const observation = monitor.observeAction({ contract: c, state: state.getState(), action: repeated });
		assert.equal(observation.action, "STOP_BRANCH");
	});

	test("repeating a succeeding action only suggests a strategy change", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const monitor = createProgressMonitor({ config });

		const repeated = action("read", { path: "a.ts" });
		for (let i = 0; i < 3; i++) {
			state.recordProposedAction({
				id: `a${i}`,
				toolName: "read",
				summary: "read",
				signature: repeated.signature,
				at: new Date().toISOString(),
				stateVersion: state.getVersion(),
				outcome: "succeeded",
			});
		}

		assert.equal(monitor.observeAction({ contract: c, state: state.getState(), action: repeated }).action, "CHANGE_STRATEGY");
	});
});

describe("State persistence and recovery (§49)", () => {
	test("a task survives a restart and rebuilds from the event log", () => {
		const paths = tempPaths();
		try {
			const c = contract({ id: "task-restart", goal: "survive a restart" });
			const first = createStateManager(c.id, c, { paths, snapshotEveryEvents: 1 });
			first.lockContract(c);
			first.addEvidence({
				id: "evd-1",
				requirementIds: ["r1"],
				type: "command_result",
				summary: "exit 0",
				sourceType: "command",
				source: "make test",
				observedAt: new Date().toISOString(),
				stateVersion: first.getVersion(),
				freshnessClass: "temporary",
				trust: "runtime_evidence",
			});
			const versionBefore = first.getVersion();
			first.flush();

			const restored = restoreStateManager(paths, c.id);
			assert.ok(restored, "the task should be restorable");
			assert.equal(restored.state.stateVersion, versionBefore);
			assert.equal(restored.state.evidence.length, 1);
			assert.equal(restored.state.contract.goal, "survive a restart");

			// Continuing after restore must not restart the version counter.
			// `lockContract` already moved the phase to "active", so transition somewhere else.
			restored.manager.setPhase("gating");
			assert.ok(
				restored.manager.getVersion() > versionBefore,
				`version should advance past ${versionBefore}, got ${restored.manager.getVersion()}`,
			);
		} finally {
			paths.cleanup();
		}
	});

	test("a truncated final event line does not prevent recovery", async () => {
		const paths = tempPaths();
		try {
			const { appendFileSync } = await import("node:fs");
			const c = contract({ id: "task-truncated" });
			const first = createStateManager(c.id, c, { paths, snapshotEveryEvents: 1 });
			first.lockContract(c);
			first.flush();

			// Simulate a crash mid-write.
			appendFileSync(`${paths.tasksDir}/task-truncated/events.jsonl`, '{"id":"ev-x","type":"tool_all');

			const restored = restoreStateManager(paths, c.id);
			assert.ok(restored, "a truncated tail must not make the task unrecoverable");
		} finally {
			paths.cleanup();
		}
	});
});

describe("Checkpoint detection failure modes", () => {
	test("an ambiguous action gates conservatively when the Judge is unreachable", async () => {
		const detector = createCheckpointDetector({
			config,
			judge: brokenJudge(new HarnessError("JUDGE_UNREACHABLE", "down")),
		});

		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const decision = await detector.evaluate({
			contract: c,
			state: state.getState(),
			// Transmission verb, no contract signal: ambiguous by construction.
			action: action("http_post", { url: "https://api.example.com/send", body: "{}" }),
		});

		assert.equal(decision.needsGate, true, "when in doubt about whether to check, check");
	});

	test("completion is always gated when the contract has success conditions", () => {
		const detector = createCheckpointDetector({ config });
		const c = contract({
			successConditions: [{ id: "s1", description: "x", source: "user", priority: "hard", status: "pending" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const decision = detector.evaluateCompletion({ contract: c, state: state.getState() });
		assert.equal(decision.needsGate, true);
		assert.equal(decision.severity, "critical");
		assert.ok(decision.relatedRequirements.includes("s1"));
	});
});

describe("Destructive-action detection cannot be defeated by rephrasing", () => {
	/**
	 * Regression test for a gap found during a live run against Pi.
	 *
	 * The contract named "delete the .log files" as a critical action. `find … -delete`
	 * was correctly blocked three times, and the model then reached the same outcome
	 * with `rm -f -- ./*.log`, which contained none of the contract's words and no verb
	 * the generic signal recognised. Equivalent destructive commands must gate alike,
	 * or the gate is merely a vocabulary filter.
	 */
	const equivalents = [
		"find . -maxdepth 1 -type f -name '*.log' -delete",
		"rm -f -- ./*.log",
		"rm ./app.log",
		"rm -rf build/",
		"unlink ./app.log",
		"shred -u secrets.txt",
	];

	for (const command of equivalents) {
		test(`gates: ${command}`, async () => {
			const detector = createCheckpointDetector({ config });
			const c = contract();
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);

			const decision = await detector.evaluate({
				contract: c,
				state: state.getState(),
				action: action("bash", { command }),
			});

			assert.equal(decision.needsGate, true, `"${command}" must be gated`);
			assert.equal(decision.severity, "critical");
		});
	}

	test("ordinary read-only commands are still not gated", async () => {
		const detector = createCheckpointDetector({ config });
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		for (const command of ["ls -la", "cat app.py", "grep -r TODO src/", "git status"]) {
			const decision = await detector.evaluate({
				contract: c,
				state: state.getState(),
				action: action("bash", { command }),
			});
			assert.equal(decision.needsGate, false, `"${command}" must take the fast path`);
		}
	});
});
