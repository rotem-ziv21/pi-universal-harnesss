import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createEvidenceCollector } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { createDeterministicJudge } from "../src/judges/deterministic.ts";
import { buildJudgeQuery } from "../src/judges/payload.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createHarnessCore } from "../src/pi/harness.ts";
import { createRuntime } from "../src/pi/runtime.ts";
import { createProgressMonitor } from "../src/progress/monitor.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { nullLogger } from "../src/util/logger.ts";
import { action, contract, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

/**
 * Regression tests for the failure a live run exposed: the worker was sent round in
 * circles by the harness itself.
 *
 * The contract had requirements with no typed verification route. Nothing the worker
 * did could ever become linked runtime evidence, yet every gate demanded exactly that,
 * every block said "gather the missing evidence and try again", and every completion
 * was rejected with `triggerTurn`. The worker read files, re-ran commands, was blocked
 * again, and finally claimed the task was done when it was not.
 *
 * These tests pin the properties that make that loop impossible.
 */

const smokeContract = contract({
	id: "task-loop",
	originalRequest: "Add a comment to app.py explaining what it does. Do not modify README.md. Then delete all the .log files.",
	goal: "Comment app.py and remove the log files without touching README.md",
	requirements: [
		{ id: "r1", description: "Add a comment to app.py explaining what it does", source: "user", priority: "hard", status: "pending" },
		{ id: "r2", description: "Delete all .log files in the working directory", source: "user", priority: "hard", status: "pending" },
	],
	constraints: [{ id: "c1", description: "README.md must not be modified", source: "user", priority: "hard" }],
	criticalActions: [
		{
			id: "a1",
			description: "Delete all .log files in the working directory",
			source: "user",
			reversible: "no",
			requiresVerificationOf: [],
			action: { capabilities: ["delete_resource"] },
		},
	],
});

function buildCore(options: {
	c?: ReturnType<typeof contract>;
	judgeResponse?: Parameters<typeof scriptedJudge>[0];
	confirm?: (title: string, message: string) => Promise<boolean>;
	config?: ReturnType<typeof testConfig>;
}) {
	const c = options.c ?? smokeContract;
	const config = options.config ?? testConfig();
	const paths = tempPaths();
	const state = createStateManager(c.id, c, { persist: false });
	state.lockContract(c);
	const judge = scriptedJudge(options.judgeResponse ?? (() => ({ decision: "PASS", confidence: 0.95 })));
	const core = createHarnessCore({
		config,
		paths,
		state,
		detector: createCheckpointDetector({ config, judge }),
		planner: createEvidencePlanner(),
		collector: createEvidenceCollector(),
		judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
		progress: createProgressMonitor({ config }),
		logger: nullLogger,
		...(options.confirm ? { confirmWithUser: options.confirm } : {}),
	});
	return { core, state, judge, cleanup: () => paths.cleanup() };
}

describe("An action gate asks only about the action", () => {
	test("a critical deletion is not asked to prove unrelated requirements first", async () => {
		const { core, judge, cleanup } = buildCore({});
		try {
			const outcome = await core.gateAction({
				action: action("bash", { command: "rm -- ./*.log" }, "bash: rm -- ./*.log"),
				cwd: process.cwd(),
			});
			assert.equal(outcome.allowed, true);
			assert.equal(judge.calls.length, 1, "the critical action is still judged");
			const query = judge.calls[0]!;
			assert.deepEqual(
				query.requirements.map((r) => r.id),
				[],
				"r1 (the app.py comment) must not be attached to the deletion gate — the worker could never prove it there",
			);
			assert.equal(outcome.plan?.unverifiable.length, 0, "no unrelated unverifiable items are dragged into the plan");
		} finally {
			cleanup();
		}
	});

	test("the Judge sees what the worker's tools returned, labelled as runtime observations", async () => {
		const { core, state, judge, cleanup } = buildCore({});
		try {
			const listing = action("bash", { command: "ls -la" });
			await core.gateAction({ action: listing, cwd: process.cwd() });
			core.recordToolResult({ actionId: listing.id, summary: "app.py\nold.log\ndebug.log", isError: false });

			await core.gateAction({ action: action("bash", { command: "rm -- ./*.log" }), cwd: process.cwd() });
			const payload = judge.calls.at(-1)!.state;
			assert.equal(payload.runtimeObservations.length, 1);
			assert.equal(payload.runtimeObservations[0]?.outcome, "succeeded");
			assert.ok(payload.runtimeObservations[0]?.result.includes("old.log"));
			assert.equal(state.getState().evidence.length, 0, "observations are context for the Judge, not linked evidence");
		} finally {
			cleanup();
		}
	});

	test("a completion gate marks requirements the harness cannot verify itself", async () => {
		const state = createStateManager(smokeContract.id, smokeContract, { persist: false });
		state.lockContract(smokeContract);
		const query = buildJudgeQuery({
			contract: smokeContract,
			state: state.getState(),
			checkpoint: {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "completion",
				signals: [],
				relatedRequirements: ["r1", "r2"],
				escalated: false,
			},
			action: action("bash", { command: "true" }),
		});
		assert.deepEqual(
			query.requirements.map((r) => [r.id, r.verifiable]),
			[
				["r1", false],
				["r2", false],
			],
		);
	});
});

describe("The deterministic Judge does not demand the impossible", () => {
	test("an unverifiable hard requirement goes to a human instead of MORE_EVIDENCE", async () => {
		const judge = createDeterministicJudge({ config: testConfig().judge });
		const decision = await judge.evaluate({
			state: { evidence: [] } as never,
			requirements: [{ id: "r1", description: "the comment reads well", priority: "hard", verifiable: false }],
			constraints: [],
			checkpointType: "completion_claim",
			stateVersion: 1,
		});
		assert.equal(decision.decision, "REVIEW");
		assert.equal(decision.missingEvidence.length, 0, "there is nothing the worker could collect");
	});

	test("a verifiable hard requirement without evidence is still MORE_EVIDENCE", async () => {
		const judge = createDeterministicJudge({ config: testConfig().judge });
		const decision = await judge.evaluate({
			state: { evidence: [] } as never,
			requirements: [{ id: "s1", description: "tests pass", priority: "hard", verifiable: true }],
			constraints: [],
			checkpointType: "completion_claim",
			stateVersion: 1,
		});
		assert.equal(decision.decision, "MORE_EVIDENCE");
	});
});

describe("A blocked action that is retried unchanged goes to the user", () => {
	test("NO_PROGRESS asks the user when a UI exists, and their approval allows it", async () => {
		const asked: string[] = [];
		const { core, state, cleanup } = buildCore({
			judgeResponse: () => ({ decision: "MORE_EVIDENCE", confidence: 0.9, missingEvidence: ["r2: not shown"] }),
			confirm: async (title) => {
				asked.push(title);
				return true;
			},
		});
		try {
			const rm = () => action("bash", { command: "rm -- ./*.log" });
			const first = await core.gateAction({ action: rm(), cwd: process.cwd() });
			assert.equal(first.allowed, false);
			assert.equal(asked.length, 0, "the first block is a Judge decision, not a question");

			const second = await core.gateAction({ action: rm(), cwd: process.cwd() });
			assert.equal(asked.length, 1, "the identical retry is put to the user instead of being blocked again");
			assert.ok(asked[0]?.includes("blocked before"));
			assert.equal(second.allowed, true);
			assert.equal(state.getState().checkpoints.at(-1)?.outcome, "allowed");
		} finally {
			cleanup();
		}
	});

	test("NO_PROGRESS without a UI blocks and tells the worker that retrying cannot work", async () => {
		const { core, cleanup } = buildCore({
			judgeResponse: () => ({ decision: "MORE_EVIDENCE", confidence: 0.9, missingEvidence: ["r2: not shown"] }),
		});
		try {
			const rm = () => action("bash", { command: "rm -- ./*.log" });
			await core.gateAction({ action: rm(), cwd: process.cwd() });
			const second = await core.gateAction({ action: rm(), cwd: process.cwd() });
			assert.equal(second.allowed, false);
			assert.equal(second.terminate, undefined);
			assert.ok(second.message?.includes("NO_PROGRESS"));
			assert.ok(second.message?.includes("stop and tell the user"));
		} finally {
			cleanup();
		}
	});
});

describe("The completion gate cannot loop", () => {
	const rejecting = () => ({
		decision: "MORE_EVIDENCE" as const,
		confidence: 0.9,
		missingEvidence: ["r1: Add a comment to app.py — not sufficiently supported (p=0.20)."],
	});

	test("a second claim with no new action halts instead of restarting the worker", async () => {
		const { core, state, cleanup } = buildCore({ judgeResponse: rejecting });
		try {
			const first = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(first.allowed, false);
			assert.equal(first.resume, true);
			assert.equal(state.getState().phase, "verify");

			// The worker did nothing and said "done" again.
			const second = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(second.allowed, false, "the harness never pretends the task is verified");
			assert.equal(second.resume, false, "but it stops bouncing the worker");
			assert.ok(second.message?.includes("stopped the verify/retry loop"));
			assert.ok(second.message?.includes("without performing any new action"));
			assert.equal(state.getState().phase, "awaiting_user");
		} finally {
			cleanup();
		}
	});

	test("the rejection budget is finite even when the worker keeps trying", async () => {
		const config = testConfig({ progress: { ...testConfig().progress, maxCompletionRejections: 2 } });
		const { core, state, cleanup } = buildCore({ judgeResponse: rejecting, config });
		try {
			const work = async (n: number) => {
				const a = action("bash", { command: `cat app.py # attempt ${n}` });
				await core.gateAction({ action: a, cwd: process.cwd() });
				core.recordToolResult({ actionId: a.id, summary: "print('hi')", isError: false });
			};

			await work(1);
			assert.equal((await core.gateCompletion({ cwd: process.cwd() })).resume, true);
			await work(2);
			assert.equal((await core.gateCompletion({ cwd: process.cwd() })).resume, true);
			await work(3);
			const third = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(third.resume, false, "third rejection exceeds maxCompletionRejections=2");
			assert.ok(third.message?.includes("the configured maximum"));
			assert.equal(state.getState().phase, "awaiting_user");
			assert.equal(state.getState().counters.completionAttempts, 3);
		} finally {
			cleanup();
		}
	});

	test("a verified completion is unaffected by the guard", async () => {
		const { core, state, cleanup } = buildCore({ judgeResponse: () => ({ decision: "PASS", confidence: 0.97 }) });
		try {
			const outcome = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(outcome.allowed, true);
			assert.equal(state.getState().phase, "completed");
		} finally {
			cleanup();
		}
	});

	test("a user-set limit parks the task for the user rather than restarting it", async () => {
		const limited = contract({
			...smokeContract,
			constraints: [{ id: "c9", description: "Stop after 1 attempt", source: "user", priority: "hard" }],
		});
		const { core, state, cleanup } = buildCore({ c: limited });
		try {
			await core.gateAction({ action: action("bash", { command: "ls" }), cwd: process.cwd() });
			const blocked = await core.gateAction({ action: action("bash", { command: "ls" }), cwd: process.cwd() });
			assert.equal(blocked.allowed, false);
			assert.equal(blocked.terminate, true);
			assert.equal(state.getState().phase, "awaiting_user", "branch_stopped hands the task to the user");
		} finally {
			cleanup();
		}
	});
});

describe("Tasks do not outlive their usefulness", () => {
	class Registry {
		find(provider: string, modelId: string): unknown {
			return { id: modelId, provider };
		}
		hasConfiguredAuth(): boolean {
			return true;
		}
		getAvailable(): Array<{ id: string; provider: string }> {
			return [];
		}
		async complete(): Promise<{ content: Array<{ type: string; text?: string }> }> {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							goal: "updated goal",
							requirements: [{ description: "the newest request is honoured", source: "user", priority: "hard" }],
							constraints: [{ description: "README.md must not be modified", source: "user", priority: "hard" }],
						}),
					},
				],
			};
		}
	}

	const makeRuntime = (paths: ReturnType<typeof tempPaths>, resumeWithinHours: number) => {
		mkdirSync(paths.harnessDir, { recursive: true });
		writeFileSync(
			paths.configFile,
			JSON.stringify({ contractReviewer: { enabled: false }, state: { resumeWithinHours }, judge: { enabled: false } }),
		);
		return createRuntime({
			host: { model: { id: "m", provider: "p" }, modelRegistry: new Registry() as never },
			cwd: paths.configDir,
			projectTrusted: false,
			paths,
		});
	};

	test("a recent unfinished task is resumed; a stale one is not", async () => {
		const paths = tempPaths();
		try {
			const first = makeRuntime(paths, 12);
			const task = await first.startTask({ request: "Add a comment to app.py and delete the logs", cwd: paths.configDir, availableTools: [] });
			task.state.flush();

			assert.equal(makeRuntime(paths, 12).restoreTask()?.id, task.id, "touched minutes ago: resume it");
			assert.equal(makeRuntime(paths, 0).restoreTask(), undefined, "older than the window: leave it alone");
		} finally {
			paths.cleanup();
		}
	});

	test("a new substantive prompt revises the contract instead of ignoring it", async () => {
		const paths = tempPaths();
		try {
			const rt = makeRuntime(paths, 12);
			const task = await rt.startTask({ request: "Add a comment to app.py and delete the logs", cwd: paths.configDir, availableTools: [] });
			task.state.setPhase("awaiting_user", "test");

			const revised = await rt.reviseTask({
				request: "Actually also rename app.py to main.py and keep README untouched",
				cwd: paths.configDir,
				availableTools: [],
			});
			assert.equal(revised.id, task.id, "same task, same event log");
			assert.equal(revised.contract.version, 2);
			assert.equal(revised.contract.goal, "updated goal");
			assert.ok(revised.contract.originalRequest.includes("[follow-up]"));
			assert.equal(revised.state.getState().phase, "plan");
			assert.equal(revised.state.getState().revisions.length, 1);
		} finally {
			paths.cleanup();
		}
	});
});
