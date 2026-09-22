import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStubModelAdapter } from "../src/models/model-adapter.ts";
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

describe("Second live run: false positives that blocked correct work", () => {
	test("redirecting to /dev/null is not a write outside the workspace", async () => {
		const { core, judge, cleanup } = buildCore({});
		try {
			for (const command of ["ls -la && git log --oneline -5 2>/dev/null; git status", "npm test >/dev/null 2>&1", "cat < /dev/null"]) {
				const outcome = await core.gateAction({ action: action("bash", { command }), cwd: process.cwd() });
				assert.equal(outcome.allowed, true, `"${command}" must not be blocked`);
			}
			assert.equal(judge.calls.length, 0, "and it must not cost a Judge call either");
		} finally {
			cleanup();
		}
	});

	test("a condition the harness verified itself is not put back to the Judge", async () => {
		const c = contract({
			...smokeContract,
			id: "task-settled",
			successConditions: [
				{
					id: "s1",
					description: "npm test exits successfully",
					source: "user",
					priority: "hard",
					status: "pending",
					verification: [{ kind: "command_execution", program: "npm test", args: [], expectExitCode: 0 }],
				},
			],
		});
		const paths = tempPaths();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const executed: string[] = [];
		const judge = scriptedJudge((query) => {
			// A Judge that, like the live one, would rate everything it is asked about at 0.06.
			const support = Object.fromEntries(query.requirements.map((r) => [r.id, 0.06]));
			return { decision: "PASS", confidence: 0.9, detail: { requirementSupport: support } };
		});
		const config = testConfig();
		const core = createHarnessCore({
			config,
			paths,
			state,
			detector: createCheckpointDetector({ config, judge }),
			planner: createEvidencePlanner(),
			collector: createEvidenceCollector({
				exec: async (program, args) => {
					executed.push([program, ...args].join(" "));
					return { stdout: "# pass 1\n# fail 0", stderr: "", exitCode: 0 };
				},
			}),
			judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
			progress: createProgressMonitor({ config }),
			logger: nullLogger,
		});
		try {
			const outcome = await core.gateCompletion({ cwd: process.cwd() });
			assert.deepEqual(executed, ["npm test"], "'npm test' with empty args is run as argv, not rejected");
			const asked = judge.calls.at(-1)!.requirements.map((r) => r.id);
			assert.ok(!asked.includes("s1"), `s1 was settled by the harness's own check; the Judge was asked about ${asked.join(", ")}`);
			assert.deepEqual(asked, ["r1", "r2"], "only the items the harness could not settle reach the Judge");
			assert.equal(outcome.allowed, true);
			assert.equal(state.getState().evidence[0]?.result, "supported");
		} finally {
			paths.cleanup();
		}
	});
});

describe("Third live run: semantic evaluation must see real content", () => {
	test("the reviewer is handed file contents, directory listings and tool results, not names", async () => {
		const paths = tempPaths();
		try {
			mkdirSync(join(paths.configDir, "out"), { recursive: true });
			writeFileSync(join(paths.configDir, "out", "clean.csv"), "name,age\nAlice,30\n");
			const prompts: string[] = [];
			const reviewer = createStubModelAdapter((request) => {
				prompts.push(request.userPrompt);
				return "VERIFIED — the listing shows no .txt files.";
			});
			const c = contract({
				metadata: { createdAt: new Date().toISOString(), cwd: paths.configDir },
				successConditions: [
					{
						id: "s1",
						description: "All scratch .txt files have been deleted from out/",
						source: "user",
						priority: "hard",
						status: "pending",
						verification: [{ kind: "semantic_evaluation", instructions: "Confirm out/ contains no .txt files", evidenceSources: ["out/", "out/clean.csv", "out/missing.txt"] }],
					},
				],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const rm = action("bash", { command: "rm out/*.txt && ls out/" });
			state.recordProposedAction({ ...rm, at: new Date().toISOString(), stateVersion: 1, outcome: "pending" });
			state.recordAllowed(rm.id);
			state.recordToolResult(rm.id, "clean.csv", false);

			const plan = createEvidencePlanner().plan({
				contract: c,
				state: state.getState(),
				checkpoint: { needsGate: true, checkpointType: "completion_claim", severity: "critical", reason: "completion", signals: [], relatedRequirements: ["s1"], escalated: false },
				checkpointId: "ckpt-1",
				action: action("bash", { command: "true" }),
			});
			const result = await createEvidenceCollector({ reviewer }).collect({ plan, cwd: paths.configDir, state: state.getState() });

			assert.equal(result.collected[0]?.result, "supported");
			assert.equal(result.collected[0]?.trust, "model_interpretation", "still Level 3: it never becomes a deterministic fact");
			const prompt = prompts[0]!;
			assert.ok(prompt.includes("entries: clean.csv"), "directory listing is supplied");
			assert.ok(prompt.includes("Alice,30"), "file contents are supplied");
			assert.ok(prompt.includes("(does not exist)"), "absence is reported, not guessed");
			assert.ok(prompt.includes("rm out/*.txt") && prompt.includes("succeeded"), "recent tool results are supplied");
		} finally {
			paths.cleanup();
		}
	});
});

describe("Fourth live run: a coarse forbid policy must not brick the task", () => {
	const paths = tempPaths();
	const base = (policy: Record<string, unknown>) =>
		contract({
			id: "task-only-summary",
			originalRequest: "Write summary.md. Do not create any other files.",
			goal: "Write summary.md and nothing else",
			metadata: { createdAt: new Date().toISOString(), cwd: paths.configDir },
			workspace: { allowedScopes: [paths.configDir], protectedResources: [] },
			requirements: [{ id: "r1", description: "summary.md exists with the comparison", source: "user", priority: "hard", status: "pending" }],
			constraints: [
				{
					id: "c1",
					description: "Only create summary.md; do not create other files",
					source: "user",
					priority: "hard",
					policy: { effect: "forbid", action: policy },
				},
			],
		});

	function coreFor(c: ReturnType<typeof contract>) {
		const config = testConfig();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const judge = scriptedJudge(() => ({ decision: "PASS", confidence: 0.95 }));
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
		});
		return { core, judge, state };
	}

	test("a forbid-all-creation policy gates the requested file instead of blocking it", async () => {
		try {
			// What the compiler actually produced: no way to say "except summary.md".
			const { core, judge } = coreFor(base({ operations: ["create"] }));
			const outcome = await core.gateAction({
				action: action("write", { path: join(paths.configDir, "summary.md"), content: "# x" }),
				cwd: paths.configDir,
			});
			assert.equal(outcome.allowed, true, "the Judge, not a deterministic block, decides");
			assert.equal(judge.calls.length, 1);
			assert.ok(judge.calls[0]!.constraints.some((c) => c.id === "c1"), "the Judge is asked about c1 specifically");
			assert.ok(judge.calls[0]!.state.userInstructions.some((u) => u.includes("summary.md")), "and sees the user's instruction");

			// Deletion under the same kind of policy still blocks without a Judge.
			const deleting = coreFor(base({ operations: ["delete"] }));
			const blocked = await deleting.core.gateAction({ action: action("bash", { command: "rm notes.txt" }), cwd: paths.configDir });
			assert.equal(blocked.allowed, false);
			assert.equal(blocked.checkpoint?.policyDecision, "block");
			assert.equal(deleting.judge.calls.length, 0);
		} finally {
			paths.cleanup();
		}
	});

	test("excludeTargets lets the compiler say 'nothing except summary.md'", async () => {
		const p2 = tempPaths();
		try {
			const c = contract({
				...base({ operations: ["create"], excludeTargets: ["summary.md"] }),
				metadata: { createdAt: new Date().toISOString(), cwd: p2.configDir },
				workspace: { allowedScopes: [p2.configDir], protectedResources: [] },
			});
			const { core, judge } = coreFor(c);
			const allowed = await core.gateAction({ action: action("write", { path: join(p2.configDir, "summary.md"), content: "# x" }), cwd: p2.configDir });
			assert.equal(allowed.allowed, true);
			assert.equal(judge.calls.length, 0, "the excluded file does not even match the policy");

			const other = await core.gateAction({ action: action("write", { path: join(p2.configDir, "notes.md"), content: "x" }), cwd: p2.configDir });
			assert.equal(other.checkpoint?.needsGate, true, "any other creation still matches the policy");
		} finally {
			p2.cleanup();
		}
	});
});

describe("A write is observed on disk so the Judge can see the document", () => {
	test("the tool result carries the written file's head, redacted and capped", async () => {
		const paths = tempPaths();
		try {
			const { core, state, cleanup } = buildCore({
				c: contract({
					...smokeContract,
					metadata: { createdAt: new Date().toISOString(), cwd: paths.configDir },
					workspace: { allowedScopes: [paths.configDir], protectedResources: [] },
				}),
			});
			try {
				const path = join(paths.configDir, "summary.md");
				const write = action("write", { path, content: "# Comparison\n\nSQLite is small.\n\n| Name | License |\n" });
				await core.gateAction({ action: write, cwd: paths.configDir });
				writeFileSync(path, "# Comparison\n\nSQLite is small. API_KEY=sk-live-abc123\n\n| Name | License |\n");
				core.recordToolResult({ actionId: write.id, summary: "Successfully wrote 60 bytes", isError: false });

				const recorded = state.getState().actions.find((a) => a.id === write.id)!;
				assert.ok(recorded.resultSummary?.includes("observed on disk after the write"));
				assert.ok(recorded.resultSummary?.includes("| Name | License |"), "the Judge can now see the table");
				assert.ok(!recorded.resultSummary?.includes("sk-live-abc123"), "secrets in written files are redacted");
			} finally {
				cleanup();
			}
		} finally {
			paths.cleanup();
		}
	});
});

describe("Scratch files in the system temp directory are not policy violations", () => {
	test("curl -o /tmp/... is classified as a write, and the write is in scope", async () => {
		const paths = tempPaths();
		try {
			const c = contract({
				...smokeContract,
				metadata: { createdAt: new Date().toISOString(), cwd: paths.configDir },
				workspace: { allowedScopes: [paths.configDir], protectedResources: [] },
			});
			const { core, judge, cleanup } = buildCore({ c });
			try {
				const fetch = action("bash", { command: "curl -sL -o /tmp/page.html https://example.com/newsletter" });
				const effects = fetch.actionSemantics.effects;
				assert.ok(effects.some((e) => e.operation === "create" || e.operation === "modify"), "the -o target is a file effect");

				const outcome = await core.gateAction({ action: fetch, cwd: paths.configDir });
				assert.equal(outcome.allowed, true);
				assert.equal(judge.calls.length, 0, "scratch output needs no Judge");

				const redirect = await core.gateAction({ action: action("bash", { command: "printf x > /tmp/scratch.txt" }), cwd: paths.configDir });
				assert.equal(redirect.allowed, true, "a redirection into the temp dir is scratch, not an out-of-scope mutation");

				const elsewhere = await core.gateAction({ action: action("bash", { command: "printf x > /etc/scratch.txt" }), cwd: paths.configDir });
				assert.equal(elsewhere.allowed, false, "writes outside workspace and temp are still blocked");
				assert.equal(elsewhere.checkpoint?.policyDecision, "block");
			} finally {
				cleanup();
			}
		} finally {
			paths.cleanup();
		}
	});
});
