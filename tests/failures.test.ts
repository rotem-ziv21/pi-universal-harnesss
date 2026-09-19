import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { createModelContractReviewer } from "../src/contract/reviewer.ts";
import { droppedHardUserItems, lock, revise } from "../src/contract/revisions.ts";
import { createDeterministicJudge } from "../src/judges/deterministic.ts";
import { isStale } from "../src/judges/judge.ts";
import { createOpenRouterJevJudge } from "../src/judges/openrouter-jev.ts";
import { resolveMountPoint } from "../src/pi/doctor.ts";
import { createKeyResolver, OPENROUTER_ENV_VAR, writeSecret } from "../src/security/secrets.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createPinnedModelAdapter, createStubModelAdapter } from "../src/models/model-adapter.ts";
import { completeStructured } from "../src/models/structured.ts";
import { checkUserLimits, createProgressMonitor, parseNumericLimit } from "../src/progress/monitor.ts";
import { createRuntime } from "../src/pi/runtime.ts";
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
		const judge = createOpenRouterJevJudge({ config: config.judge, getApiKey: async () => undefined });
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
			getApiKey: async () => "sk-or-v1-test",
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
			getApiKey: async () => "sk-or-v1-test",
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

	test("a malformed response is retried, then rejected rather than half-interpreted", async () => {
		let calls = 0;
		const judge = createOpenRouterJevJudge({
			config: { ...config.judge, maxRetries: 1 },
			getApiKey: async () => "sk-or-v1-test",
			fetchImpl: fakeFetch(() => {
				calls++;
				return { body: { model: "jev", nonsense: true } };
			}),
		});

		await assert.rejects(
			() => judge.evaluate({ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 }),
			(e: unknown) => e instanceof HarnessError && e.code === "JUDGE_BAD_RESPONSE",
		);
		assert.equal(calls, 2);
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
			getApiKey: async () => "sk-or-v1-test",
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

		const decision = await createOpenRouterJevJudge({ config: config.judge, getApiKey: async () => "sk-or-v1-test", fetchImpl }).evaluate(query);

		const call = fetchImpl.calls[0]!;
		assert.ok(call.url.endsWith("/alpha/decisions"), `expected the decisions endpoint, got ${call.url}`);

		const body = call.body as { model: string; state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };
		assert.equal(body.model, "~typesafe/jev-latest");
		assert.equal(body.questions.verdict?.type, "choice");
		assert.equal(body.questions.req_r1?.type, "noul");
		assert.equal(body.questions.con_c1?.type, "noul");
		assert.ok(decision.debug?.requestHash);
		assert.ok(decision.debug?.semanticHash);
		assert.deepEqual(decision.debug?.evidenceIds, []);
		const debugRequest = decision.debug?.request;
		assert.ok(debugRequest && typeof debugRequest === "object" && "questions" in debugRequest);
		assert.deepEqual(debugRequest.questions, body.questions);

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
			result: "unknown" as const,
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
			result: "unknown" as const,
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
				actionSemantics: repeated.actionSemantics,
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
				actionSemantics: repeated.actionSemantics,
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
				actionSemantics: repeated.actionSemantics,
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
				result: "supported",
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

describe("Ephemeral state detection in containers", () => {
	/**
	 * State on a container's root overlay is destroyed when the container is recreated.
	 * The directory looks perfectly healthy until the restart, so the diagnostic has to
	 * reason about mount points rather than about whether the path is writable.
	 */
	const MOUNTS = [
		"overlay / overlay rw,relatime 0 0",
		"proc /proc proc rw,nosuid 0 0",
		"/dev/sda1 /workspace ext4 rw,relatime 0 0",
		"tmpfs /workspace/cache tmpfs rw 0 0",
		"tmpfs /workspacefoo tmpfs rw 0 0",
		"none /mnt/with\\040space ext4 rw 0 0",
	].join("\n");

	test("state on the container overlay resolves to the root filesystem", () => {
		assert.equal(resolveMountPoint("/root/.pi/agent/harness", MOUNTS), "/");
	});

	test("state on a mounted volume resolves to that volume", () => {
		assert.equal(resolveMountPoint("/workspace/.pi/agent/harness", MOUNTS), "/workspace");
	});

	test("the longest matching mount wins, because mounts nest", () => {
		assert.equal(resolveMountPoint("/workspace/cache/thing", MOUNTS), "/workspace/cache");
	});

	test("a shared prefix is not a match without a separator", () => {
		// /workspacefoo must not be attributed to /workspace.
		assert.equal(resolveMountPoint("/workspacefoo/harness", MOUNTS), "/workspacefoo");
	});

	test("the mount point itself matches", () => {
		assert.equal(resolveMountPoint("/workspace", MOUNTS), "/workspace");
	});

	test("octal-escaped mount points are decoded", () => {
		assert.equal(resolveMountPoint("/mnt/with space/harness", MOUNTS), "/mnt/with space");
	});

	test("unparseable input yields no answer rather than a wrong one", () => {
		assert.equal(resolveMountPoint("/root/x", ""), undefined);
	});
});

describe("Credentials come from Pi itself (§/login)", () => {
	/**
	 * Pi's `/login` already stores an OpenRouter key, and its ModelRegistry resolves
	 * both that store and the environment variable. Reading through Pi means one place
	 * to log in and one place to rotate, instead of a parallel secret the user has to
	 * carry between machines.
	 */
	const host = (key?: string) => ({ getApiKeyForProvider: async () => key });

	test("a key Pi holds is preferred over the harness's own store", async () => {
		const paths = tempPaths();
		try {
			writeSecret(paths, OPENROUTER_ENV_VAR, "sk-or-v1-from-harness-store");
			const resolved = await createKeyResolver({ paths, host: host("sk-or-v1-from-pi") })();

			assert.equal(resolved.source, "pi");
			assert.equal(resolved.value, "sk-or-v1-from-pi");
		} finally {
			paths.cleanup();
		}
	});

	test("the harness store is still honoured when Pi has no key", async () => {
		const paths = tempPaths();
		try {
			writeSecret(paths, OPENROUTER_ENV_VAR, "sk-or-v1-from-harness-store");
			const resolved = await createKeyResolver({ paths, host: host(undefined) })();

			assert.equal(resolved.source, "store");
			assert.equal(resolved.value, "sk-or-v1-from-harness-store");
		} finally {
			paths.cleanup();
		}
	});

	test("no host and no store resolves to unconfigured, not to a crash", async () => {
		const paths = tempPaths();
		try {
			const resolved = await createKeyResolver({ paths, host: undefined })();
			assert.equal(resolved.source, "none");
			assert.equal(resolved.value, undefined);
		} finally {
			paths.cleanup();
		}
	});

	test("a throwing credential lookup degrades quietly instead of breaking the gate", async () => {
		const paths = tempPaths();
		try {
			const angry = {
				getApiKeyForProvider: async () => {
					throw new Error("no such provider");
				},
			};
			const resolved = await createKeyResolver({ paths, host: angry })();
			assert.equal(resolved.source, "none");
		} finally {
			paths.cleanup();
		}
	});

	test("the key is resolved per call, so /login mid-session takes effect", async () => {
		const paths = tempPaths();
		try {
			let current: string | undefined;
			const resolve = createKeyResolver({ paths, host: { getApiKeyForProvider: async () => current } });

			assert.equal((await resolve()).source, "none", "before /login");
			current = "sk-or-v1-just-logged-in";
			assert.equal((await resolve()).source, "pi", "after /login, with no reload");
		} finally {
			paths.cleanup();
		}
	});

	test("the judge reports itself available only once a key exists", async () => {
		let current: string | undefined;
		const judge = createOpenRouterJevJudge({
			config: config.judge,
			getApiKey: async () => current,
		});

		assert.equal(await judge.isAvailable(), false);
		current = "sk-or-v1-test";
		assert.equal(await judge.isAvailable(), true);
	});

	test("a missing key names /login in the error, since that is where it comes from", async () => {
		const judge = createOpenRouterJevJudge({ config: config.judge, getApiKey: async () => undefined });
		await assert.rejects(
			() => judge.evaluate({ state: {} as never, requirements: [], constraints: [], checkpointType: "x", stateVersion: 1 }),
			(e: unknown) => e instanceof HarnessError && e.code === "JUDGE_AUTH_MISSING" && /\/login/.test(e.message),
		);
	});
});

describe("Pinning a specific model for the compiler or reviewer", () => {
	/**
	 * Regression test for a bug that only appears with a *real* registry.
	 *
	 * Pi's ModelRegistry is a class, so `complete` lives on the prototype. The pinned
	 * adapter used to swap the model lookup by spreading the registry
	 * (`{...registry, find: () => model}`), and object spread copies own properties
	 * only — producing an object with no `complete` at all. Every pinned call threw
	 * "registry.complete is not a function".
	 *
	 * A plain object literal as a test double would have hidden this completely, which
	 * is why the fake below is a class.
	 */
	class FakeRegistry {
		calls: unknown[] = [];
		known: Record<string, unknown>;

		constructor(known: Record<string, unknown>) {
			this.known = known;
		}

		find(provider: string, modelId: string): unknown {
			return this.known[`${provider}/${modelId}`];
		}
		hasConfiguredAuth(): boolean {
			return false; // A locally served model has no credential.
		}
		getProvider(id: string): { baseUrl?: string } | undefined {
			return id === "llama-cpp" ? { baseUrl: "http://127.0.0.1:8080/v1" } : { baseUrl: "https://api.example.com" };
		}
		async complete(model: unknown): Promise<{ content: Array<{ type: string; text?: string }> }> {
			this.calls.push(model);
			return { content: [{ type: "text", text: "pinned reply" }] };
		}
	}

	test("a pinned model actually completes, rather than losing the registry's methods", async () => {
		const localModel = { id: "qwen27b-local", provider: "llama-cpp" };
		const registry = new FakeRegistry({ "llama-cpp/qwen27b-local": localModel });

		const adapter = createPinnedModelAdapter(
			{ modelRegistry: registry as never, model: undefined },
			"llama-cpp",
			"qwen27b-local",
		);

		const response = await adapter.complete({ systemPrompt: "s", userPrompt: "u" });

		assert.equal(response.text, "pinned reply");
		assert.equal(adapter.id, "llama-cpp/qwen27b-local");
		assert.deepEqual(registry.calls[0], localModel, "the pinned model must be the one handed to the registry");
	});

	test("a locally served model counts as available despite having no credential", () => {
		const registry = new FakeRegistry({ "llama-cpp/qwen27b-local": { id: "qwen27b-local", provider: "llama-cpp" } });
		const adapter = createPinnedModelAdapter({ modelRegistry: registry as never, model: undefined }, "llama-cpp", "qwen27b-local");

		assert.equal(adapter.available, true, "a local model needs no API key; refusing it would break local setups");
	});

	test("a remote model with no configured auth is reported unavailable", () => {
		const registry = new FakeRegistry({ "openai/gpt-5.2": { id: "gpt-5.2", provider: "openai" } });
		const adapter = createPinnedModelAdapter({ modelRegistry: registry as never, model: undefined }, "openai", "gpt-5.2");

		assert.equal(adapter.available, false);
	});

	test("an unknown model id fails with a message that says how to find the right one", async () => {
		const registry = new FakeRegistry({});
		const adapter = createPinnedModelAdapter({ modelRegistry: registry as never, model: undefined }, "llama-cpp", "typo");

		assert.equal(adapter.available, false);
		await assert.rejects(
			() => adapter.complete({ systemPrompt: "s", userPrompt: "u" }),
			(e: unknown) => e instanceof HarnessError && e.code === "MODEL_UNAVAILABLE" && /\/model/.test(e.message),
		);
	});
});

describe("Choosing the model for harness roles", () => {
	/**
	 * `/harness model` exists because editing config.json by hand is not control: it
	 * needs a reload, it is easy to typo, and nothing validates the ids. These tests
	 * pin the behaviour that makes the command worth having — the change takes effect
	 * immediately, and it survives a restart.
	 */
	class Registry {
		completed: unknown[] = [];
		find(provider: string, modelId: string): unknown {
			return { id: modelId, provider };
		}
		hasConfiguredAuth(): boolean {
			return true;
		}
		getAvailable(): Array<{ id: string; provider: string }> {
			return [
				{ id: "qwen27b-local", provider: "llama-cpp" },
				{ id: "moonshotai/kimi-k2.6", provider: "openrouter" },
			];
		}
		async complete(model: unknown): Promise<{ content: Array<{ type: string; text?: string }> }> {
			this.completed.push(model);
			return { content: [{ type: "text", text: "{}" }] };
		}
	}

	const makeRuntime = (paths: ReturnType<typeof tempPaths>) =>
		createRuntime({
			host: { model: { id: "kimi", provider: "openrouter" }, modelRegistry: new Registry() as never },
			cwd: paths.configDir,
			projectTrusted: false,
			// Hermetic: without this the runtime resolves the real user config and these
			// tests would write settings onto the machine running them.
			paths,
		});

	test("both roles follow Pi's model until they are pinned", () => {
		const paths = tempPaths();
		try {
			const roles = makeRuntime(paths).describeRoles();
			assert.equal(roles.length, 2);
			assert.ok(roles.every((r) => r.followsPi), "the default must be to follow Pi, not to pin anything");
			assert.ok(roles.every((r) => r.modelId === "openrouter/kimi"));
		} finally {
			paths.cleanup();
		}
	});

	test("pinning takes effect immediately, with no reload", () => {
		const paths = tempPaths();
		try {
			const rt = makeRuntime(paths);
			const described = rt.setRoleModel("compiler", { provider: "llama-cpp", model: "qwen27b-local" });

			assert.equal(described.modelId, "llama-cpp/qwen27b-local");
			assert.equal(described.followsPi, false);

			// And the live view agrees, rather than only the returned value.
			const compiler = rt.describeRoles().find((r) => r.role === "compiler");
			assert.equal(compiler?.modelId, "llama-cpp/qwen27b-local");

			// The other role is untouched.
			assert.equal(rt.describeRoles().find((r) => r.role === "reviewer")?.followsPi, true);
		} finally {
			paths.cleanup();
		}
	});

	test("the two roles can use different models", () => {
		const paths = tempPaths();
		try {
			const rt = makeRuntime(paths);
			rt.setRoleModel("compiler", { provider: "llama-cpp", model: "qwen27b-local" });
			rt.setRoleModel("reviewer", { provider: "openrouter", model: "moonshotai/kimi-k2.6" });

			const roles = rt.describeRoles();
			assert.equal(roles.find((r) => r.role === "compiler")?.modelId, "llama-cpp/qwen27b-local");
			assert.equal(roles.find((r) => r.role === "reviewer")?.modelId, "openrouter/moonshotai/kimi-k2.6");
		} finally {
			paths.cleanup();
		}
	});

	test("a model id containing slashes survives the round trip", () => {
		const paths = tempPaths();
		try {
			const rt = makeRuntime(paths);
			// Only the FIRST slash separates provider from model.
			const described = rt.setRoleModel("reviewer", { provider: "openrouter", model: "moonshotai/kimi-k2.6" });
			assert.equal(described.modelId, "openrouter/moonshotai/kimi-k2.6");
		} finally {
			paths.cleanup();
		}
	});

	test("the choice is persisted, so it survives a restart", () => {
		const paths = tempPaths();
		try {
			makeRuntime(paths).setRoleModel("compiler", { provider: "llama-cpp", model: "qwen27b-local" });

			const reborn = makeRuntime(paths);
			const compiler = reborn.describeRoles().find((r) => r.role === "compiler");
			assert.equal(compiler?.modelId, "llama-cpp/qwen27b-local", "the pin must be read back from disk");
			assert.equal(compiler?.followsPi, false);
		} finally {
			paths.cleanup();
		}
	});

	test("resetting a role returns it to following Pi", () => {
		const paths = tempPaths();
		try {
			const rt = makeRuntime(paths);
			rt.setRoleModel("compiler", { provider: "llama-cpp", model: "qwen27b-local" });
			const described = rt.setRoleModel("compiler", undefined);

			assert.equal(described.followsPi, true);
			assert.equal(described.modelId, "openrouter/kimi");
		} finally {
			paths.cleanup();
		}
	});

	test("the picker lists Pi's catalogue and always includes the active model", () => {
		const paths = tempPaths();
		try {
			const labels = makeRuntime(paths).availableModels().map((m) => m.label);
			assert.ok(labels.includes("llama-cpp/qwen27b-local"));
			assert.ok(labels.includes("openrouter/moonshotai/kimi-k2.6"));
			assert.ok(labels.includes("openrouter/kimi"), "the active model must be offered even if the catalogue omits it");
		} finally {
			paths.cleanup();
		}
	});
});

describe("Model calls cannot hang the session", () => {
	/**
	 * A local model on modest hardware can take minutes for one call, and the harness
	 * had no budget at all for the compiler and reviewer — only the Judge did. A stalled
	 * model held the whole Pi session open with nothing on screen but "Reviewing…".
	 */
	test("a model that never answers fails with a budget message instead of hanging", async () => {
		const hung = {
			id: "local/slow",
			available: true,
			complete: (request: { signal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};

		await assert.rejects(
			() =>
				completeStructured(hung, {
					systemPrompt: "s",
					userPrompt: "u",
					schema: Type.Object({ goal: Type.String() }),
					timeoutMs: 60,
					maxRepairAttempts: 0,
				}),
			(e: unknown) =>
				e instanceof HarnessError && e.code === "MODEL_UNAVAILABLE" && /did not respond within/.test(e.message),
		);
	});

	test("the caller's own abort is reported as an abort, not as a timeout", async () => {
		const controller = new AbortController();
		const hung = {
			id: "local/slow",
			available: true,
			complete: (request: { signal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};

		const pending = completeStructured(hung, {
			systemPrompt: "s",
			userPrompt: "u",
			schema: Type.Object({ goal: Type.String() }),
			timeoutMs: 60_000,
			signal: controller.signal,
		});

		controller.abort();
		await assert.rejects(pending, (e: unknown) => e instanceof HarnessError && e.code === "ABORTED");
	});

	test("progress is reported per attempt, so a slow model looks busy rather than stuck", async () => {
		const attempts: Array<[number, number]> = [];
		let call = 0;

		const flaky = createStubModelAdapter(() => {
			call++;
			return call === 1 ? "not json at all" : '{"goal":"ok"}';
		});

		const result = await completeStructured<{ goal: string }>(flaky, {
			systemPrompt: "s",
			userPrompt: "u",
			schema: Type.Object({ goal: Type.String() }),
			onAttempt: (attempt, total) => attempts.push([attempt, total]),
		});

		assert.equal(result.value.goal, "ok");
		assert.deepEqual(attempts, [
			[1, 3],
			[2, 3],
		]);
	});
});

describe("Signals and planning against a weaker compiler model", () => {
	/**
	 * Both regressions here came from one live run on a local 27B model.
	 */

	test("find … -prune is read-only and must not be gated", async () => {
		const detector = createCheckpointDetector({ config });
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		const readOnly = [
			"find . -path ./node_modules -prune -o -name '*.ts' -print",
			"find . -type d -name node_modules -prune",
		];

		for (const command of readOnly) {
			const decision = await detector.evaluate({ contract: c, state: state.getState(), action: action("bash", { command }) });
			assert.equal(decision.needsGate, false, `"${command}" is a read-only search idiom and must take the fast path`);
		}
	});

	test("prune as a real command is still destructive", async () => {
		const detector = createCheckpointDetector({ config });
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);

		for (const command of ["git prune", "docker system prune -a", "find . -name '*.log' -delete"]) {
			const decision = await detector.evaluate({ contract: c, state: state.getState(), action: action("bash", { command }) });
			assert.equal(decision.needsGate, true, `"${command}" really does destroy data`);
		}
	});

	test("a command in a requirement description is found, not reported unverifiable", () => {
		/**
		 * A well-formed contract puts the command in verificationHint. Weaker models put
		 * it in the description instead — and then every requirement reported as
		 * unverifiable while the command sat in plain sight.
		 */
		const weak = contract({
			requirements: [
				{
					id: "r1",
					description: "Verify the result by running `wc -l data.csv`",
					source: "user",
					priority: "hard",
					status: "pending",
				},
			],
		});
		const state = createStateManager(weak.id, weak, { persist: false });
		state.lockContract(weak);

		const plan = createEvidencePlanner().plan({
			contract: weak,
			state: state.getState(),
			checkpoint: {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "completion",
				signals: [],
				relatedRequirements: ["r1"],
				escalated: false,
			},
			checkpointId: "ckpt-1",
			action: action("bash", { command: "true" }),
		});

		const commands = plan.evidenceRequests.filter((r) => r.kind === "command").map((r) => r.parameters.command);
		assert.deepEqual(commands, ["wc -l data.csv"]);
		assert.equal(plan.unverifiable.length, 0, "nothing should be unverifiable when the command is right there");
	});

	test("the hint still wins over the description when both carry a command", () => {
		const both = contract({
			successConditions: [
				{
					id: "s1",
					description: "Checked by running `wrong-command`",
					source: "user",
					priority: "hard",
					verificationHint: "run `right-command`",
					status: "pending",
				},
			],
		});
		const state = createStateManager(both.id, both, { persist: false });
		state.lockContract(both);

		const plan = createEvidencePlanner().plan({
			contract: both,
			state: state.getState(),
			checkpoint: {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "completion",
				signals: [],
				relatedRequirements: ["s1"],
				escalated: false,
			},
			checkpointId: "ckpt-1",
			action: action("bash", { command: "true" }),
		});

		assert.deepEqual(
			plan.evidenceRequests.map((r) => r.parameters.command),
			["right-command"],
		);
	});
});
