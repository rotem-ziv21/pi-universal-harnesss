import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { classifyAction } from "../src/checkpoints/action-semantics.ts";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import type { ProposedAction } from "../src/checkpoints/types.ts";
import type { TaskContract } from "../src/contract/schema.ts";
import { evaluateCompletionConditions } from "../src/evidence/completion.ts";
import { createEvidenceCollector, type ExecFn } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createHarnessCore } from "../src/pi/harness.ts";
import { createProgressMonitor } from "../src/progress/monitor.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import type { HarnessState } from "../src/state/types.ts";
import { nullLogger } from "../src/util/logger.ts";
import { action, contract, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

const config = testConfig();

function semanticAction(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	state?: HarnessState,
	c = contract(),
): ProposedAction {
	return {
		...action(toolName, input),
		actionSemantics: classifyAction(toolName, input, { cwd, state, contract: c }),
	};
}

function createCore(c: TaskContract, exec?: ExecFn) {
	const paths = tempPaths();
	const state = createStateManager(c.id, c, { persist: false });
	state.lockContract(c);
	const judge = scriptedJudge(() => ({
		decision: "MORE_EVIDENCE",
		confidence: 0.96,
		missingEvidence: ["r1: proof is missing"],
	}));
	const core = createHarnessCore({
		config,
		paths,
		state,
		detector: createCheckpointDetector({ config, judge }),
		planner: createEvidencePlanner(),
		collector: createEvidenceCollector(exec ? { exec } : {}),
		judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
		progress: createProgressMonitor({ config }),
		logger: nullLogger,
	});
	return { core, judge, paths, state };
}

describe("capability-aware action policy", () => {
	test("Python source containing unlink, rm -rf and git push is a file write, not an active destructive operation", async () => {
		const paths = tempPaths();
		const c = contract({
			constraints: [
				{ id: "c1", description: "Do not modify files outside the new task folder", source: "user", priority: "hard" },
				{ id: "c2", description: "Do not delete existing files", source: "user", priority: "hard" },
				{ id: "c3", description: "Do not commit or push", source: "user", priority: "hard" },
				{ id: "c4", description: "Do not add unnecessary dependencies", source: "user", priority: "hard" },
			],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		state.setPhase("build");
		try {
			const proposed = semanticAction(
				"write",
				{
					path: "task/test_cli.py",
					content: "def test_cleanup():\n    os.unlink(path)\n# never run rm -rf or git push\n",
				},
				paths.configDir,
				state.getState(),
				c,
			);
			const decision = await createCheckpointDetector({ config }).evaluate({
				contract: c,
				state: state.getState(),
				action: proposed,
			});

			assert.equal(proposed.actionSemantics.actionType, "file_write");
			assert.deepEqual(proposed.actionSemantics.capabilities, ["write_file"]);
			assert.equal(decision.needsGate, false);
		} finally {
			paths.cleanup();
		}
	});

	test("an actual rm of an existing file is blocked", async () => {
		const paths = tempPaths();
		const target = join(paths.configDir, "existing.txt");
		writeFileSync(target, "keep");
		const c = contract({
			constraints: [{ id: "c1", description: "Do not delete existing files", source: "user", priority: "hard" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const proposed = semanticAction("bash", { command: `rm ${target}` }, paths.configDir, state.getState(), c);
		try {
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(proposed.actionSemantics.targetOwnership, "preexisting");
			assert.equal(decision.needsGate, true);
			assert.equal(decision.policyDecision, "block");
		} finally {
			paths.cleanup();
		}
	});

	test("creating a test file during BUILD proceeds before test-pass evidence exists", async () => {
		const paths = tempPaths();
		const c = contract({
			requirements: [{ id: "r1", description: "The tests pass", source: "user", priority: "hard", status: "pending" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		state.setPhase("build");
		try {
			const proposed = semanticAction("write", { path: "task/test_cli.py", content: "def test_cli(): pass" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(decision.needsGate, false);
		} finally {
			paths.cleanup();
		}
	});

	test("writing README.md does not match an unrelated dependency constraint", async () => {
		const paths = tempPaths();
		const c = contract({
			constraints: [{ id: "c1", description: "Do not add unnecessary dependencies", source: "user", priority: "hard" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		state.setPhase("build");
		try {
			const proposed = semanticAction("write", { path: "task/README.md", content: "# Usage" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(decision.needsGate, false);
		} finally {
			paths.cleanup();
		}
	});

	test("an actual dependency installation is routed to a semantic constraint gate", async () => {
		const paths = tempPaths();
		const c = contract({
			constraints: [{ id: "c1", description: "Do not add unnecessary dependencies", source: "user", priority: "hard" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		state.setPhase("build");
		try {
			const proposed = semanticAction("bash", { command: "npm install left-pad" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(proposed.actionSemantics.capabilities.includes("change_dependencies"), true);
			assert.equal(decision.needsGate, true);
			assert.equal(decision.policyDecision, "gate");
			assert.deepEqual(decision.signals.flatMap((signal) => signal.relatedItemIds), ["c1"]);
		} finally {
			paths.cleanup();
		}
	});
});

describe("completion conditions and retry stability", () => {
	test("the no commit/push constraint is proven from the event log at completion", () => {
		const c = contract({
			constraints: [{ id: "c1", description: "Do not commit or push", source: "user", priority: "hard" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const evaluation = evaluateCompletionConditions({ contract: c, state: state.getState(), cwd: process.cwd() });
		assert.equal(evaluation.conditions[0]?.status, "SATISFIED");
		assert.match(evaluation.conditions[0]?.reason ?? "", /0 successful/);
	});

	test("an actual git push matching a forbidden condition is blocked without a Judge call", async () => {
		const c = contract({
			forbiddenConditions: [{ id: "f1", description: "A git push occurs", source: "user", priority: "hard" }],
		});
		const { core, judge, paths, state } = createCore(c);
		try {
			const proposed = semanticAction("bash", { command: "git push origin main" }, paths.configDir, state.getState(), c);
			const result = await core.gateAction({ action: proposed, cwd: paths.configDir });
			assert.equal(result.allowed, false);
			assert.equal(judge.calls.length, 0);
			assert.equal(state.getState().checkpoints.at(-1)?.policyDecision, "block");
		} finally {
			paths.cleanup();
		}
	});

	test("exact empty-CSV evidence satisfies its mapped success condition deterministically", async () => {
		const c = contract({
			successConditions: [{
				id: "s1",
				description: "The CSV is empty with zero rows",
				source: "user",
				priority: "hard",
				verificationHint: "run `wc -l result.csv`",
				status: "pending",
			}],
		});
		const { core, judge, paths, state } = createCore(
			c,
			async () => ({ stdout: "0 result.csv\n", stderr: "", exitCode: 0 }),
		);
		try {
			const result = await core.gateCompletion({ cwd: paths.configDir });
			assert.equal(result.allowed, true);
			assert.equal(judge.calls.length, 0);
			assert.equal(state.getState().evidence[0]?.type, "exact_output");
			assert.equal(state.getState().lastCompletionEvaluation?.conditions[0]?.status, "SATISFIED");
		} finally {
			paths.cleanup();
		}
	});

	test("README existence and usage content are checked directly", () => {
		const paths = tempPaths();
		const taskDir = join(paths.configDir, "task");
		const readme = join(taskDir, "README.md");
		mkdirSync(taskDir, { recursive: true });
		const c = contract({
			requirements: [{ id: "r1", description: "README.md contains usage instructions", source: "user", priority: "hard", status: "pending" }],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const proposed = semanticAction("write", { path: readme, content: "# Usage\n\n```sh\npython3 cli.py --help\n```" }, paths.configDir, state.getState(), c);
		writeFileSync(readme, "# Usage\n\n```sh\npython3 cli.py --help\n```\n");
		state.recordProposedAction({
			id: proposed.id,
			toolName: proposed.toolName,
			summary: proposed.summary,
			signature: proposed.signature,
			actionSemantics: proposed.actionSemantics,
			at: new Date().toISOString(),
			stateVersion: state.getVersion(),
			outcome: "succeeded",
		});
		try {
			const evaluation = evaluateCompletionConditions({ contract: c, state: state.getState(), cwd: paths.configDir });
			assert.equal(evaluation.conditions[0]?.status, "SATISFIED");
		} finally {
			paths.cleanup();
		}
	});
	test("task lifecycle advances PLAN to BUILD to VERIFY to FINALIZE", () => {
		const c = contract();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		assert.equal(state.getState().phase, "plan");

		const write = semanticAction("write", { path: "task/app.py", content: "print('ok')" }, process.cwd(), state.getState(), c);
		state.recordProposedAction({
			id: write.id,
			toolName: write.toolName,
			summary: write.summary,
			signature: write.signature,
			actionSemantics: write.actionSemantics,
			at: new Date().toISOString(),
			stateVersion: state.getVersion(),
			outcome: "pending",
		});
		state.recordAllowed(write.id);
		state.recordToolResult(write.id, "written", false);
		assert.equal(state.getState().phase, "build");

		const verify = semanticAction("bash", { command: "npm test" }, process.cwd(), state.getState(), c);
		state.recordProposedAction({
			id: verify.id,
			toolName: verify.toolName,
			summary: verify.summary,
			signature: verify.signature,
			actionSemantics: verify.actionSemantics,
			at: new Date().toISOString(),
			stateVersion: state.getVersion(),
			outcome: "pending",
		});
		state.recordAllowed(verify.id);
		state.recordToolResult(verify.id, "tests pass", false);
		assert.equal(state.getState().phase, "verify");

		state.requestCompletion();
		assert.equal(state.getState().phase, "finalize");
		state.rejectCompletion("more evidence required");
		assert.equal(state.getState().phase, "verify");
	});

	test("scope invariants count file mutations, not a test runner's argument path", () => {
		const c = contract({
			constraints: [{
				id: "c1",
				description: "Do not modify files outside the new task folder",
				source: "user",
				priority: "hard",
			}],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const verify = semanticAction(
			"bash",
			{ command: "python3 -m unittest discover -s task -p test_cli.py" },
			process.cwd(),
			state.getState(),
			c,
		);
		state.recordProposedAction({
			id: verify.id,
			toolName: verify.toolName,
			summary: verify.summary,
			signature: verify.signature,
			actionSemantics: verify.actionSemantics,
			at: new Date().toISOString(),
			stateVersion: state.getVersion(),
			outcome: "succeeded",
		});
		const evaluation = evaluateCompletionConditions({ contract: c, state: state.getState(), cwd: process.cwd() });
		assert.equal(evaluation.conditions[0]?.status, "SATISFIED");
	});

	test("a multi-item evidence batch remains current and requirement-specific at the Judge boundary", async () => {
		const c = contract({
			successConditions: [
				{
					id: "s1",
					description: "First verification holds",
					source: "user",
					priority: "hard",
					verificationHint: "run `check-one`",
					status: "pending",
				},
				{
					id: "s2",
					description: "Second verification holds",
					source: "user",
					priority: "hard",
					verificationHint: "run `check-two`",
					status: "pending",
				},
			],
			criticalActions: [{
				id: "a1",
				description: "Publish changes to a remote",
				source: "user",
				reversible: "no",
				requiresVerificationOf: ["s1", "s2"],
			}],
		});
		const paths = tempPaths();
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		let observedBundles: Array<[string, number, number]> = [];
		const judge = scriptedJudge((query) => {
			observedBundles = query.state.evidenceBundles.map((bundle) => [
				bundle.requirementId,
				bundle.selected.length,
				bundle.excluded.length,
			]);
			return { decision: "PASS", confidence: 0.99 };
		});
		const core = createHarnessCore({
			config,
			paths,
			state,
			detector: createCheckpointDetector({ config, judge }),
			planner: createEvidencePlanner(),
			collector: createEvidenceCollector({
				exec: async (command) => ({ stdout: `${command}: ok`, stderr: "", exitCode: 0, durationMs: 1 }),
			}),
			judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
			progress: createProgressMonitor({ config }),
			logger: nullLogger,
		});
		try {
			const proposed = semanticAction("bash", { command: "git push origin main" }, paths.configDir, state.getState(), c);
			const result = await core.gateAction({ action: proposed, cwd: paths.configDir });
			assert.equal(result.allowed, true);
			assert.deepEqual(observedBundles, [["s1", 1, 1], ["s2", 1, 1]]);
			assert.equal(new Set(state.getState().evidence.map((item) => item.stateVersion)).size, 1);
		} finally {
			paths.cleanup();
		}
	});

	test("an identical blocked checkpoint with no new evidence stops before another Judge call", async () => {
		const c = contract({
			requirements: [{ id: "r1", description: "Publication is verified", source: "user", priority: "hard", status: "pending" }],
			criticalActions: [{
				id: "a1",
				description: "Publish changes to a remote",
				source: "user",
				reversible: "no",
				requiresVerificationOf: ["r1"],
			}],
		});
		const { core, judge, paths, state } = createCore(c);
		try {
			const proposed = semanticAction("bash", { command: "git push origin main" }, paths.configDir, state.getState(), c);
			const first = await core.gateAction({ action: proposed, cwd: paths.configDir });
			const second = await core.gateAction({ action: proposed, cwd: paths.configDir });
			assert.equal(first.allowed, false);
			assert.equal(second.allowed, false);
			assert.match(second.message ?? "", /no new evidence/i);
			assert.equal(judge.calls.length, 1);
		} finally {
			paths.cleanup();
		}
	});
});
