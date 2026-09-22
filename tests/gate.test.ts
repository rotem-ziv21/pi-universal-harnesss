import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createEvidenceCollector, type ExecFn } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createHarnessCore } from "../src/pi/harness.ts";
import { extractCompletionClaim, signatureOf, summarize, toProposedAction } from "../src/pi/pi-adapter.ts";
import { createProgressMonitor } from "../src/progress/monitor.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { nullLogger } from "../src/util/logger.ts";
import { action, contract, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

/**
 * End-to-end gate behaviour (§45, §44).
 *
 * These are the tests that prove the harness is a control plane rather than a
 * suggestion: an action is proposed, the pipeline runs, and the action is actually
 * prevented.
 */

const config = testConfig();

function buildCore(options: {
	c?: ReturnType<typeof contract>;
	judgeResponse?: Parameters<typeof scriptedJudge>[0];
	exec?: ExecFn;
	confirm?: (title: string, message: string) => Promise<boolean>;
}) {
	const c = options.c ?? contract();
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
		collector: createEvidenceCollector(options.exec ? { exec: options.exec } : {}),
		judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
		progress: createProgressMonitor({ config }),
		logger: nullLogger,
		...(options.confirm ? { confirmWithUser: options.confirm } : {}),
	});

	return { core, state, judge, contract: c, cleanup: () => paths.cleanup() };
}

const gitPushContract = contract({
	id: "task-gate",
	originalRequest: "Fix the bug, test it, then push if safe.",
	goal: "Fix the defect and publish once verified",
	successConditions: [
		{
			id: "s1",
			description: "The test suite passes",
			source: "user",
			priority: "hard",
			verification: [{ kind: "command_execution", program: "truetest", args: [], expectExitCode: 0 }],
			status: "pending",
		},
	],
	criticalActions: [
		{
			id: "a1",
			description: "Publish the repository changes to the shared remote",
			source: "user",
			reversible: "no",
			requiresVerificationOf: ["s1"],
		},
	],
});

describe("The gate actually blocks", () => {
	test("a read passes straight through with no Judge call", async () => {
		const { core, judge, cleanup } = buildCore({ c: gitPushContract });
		try {
			const outcome = await core.gateAction({
				action: action("read", { path: "src/auth.ts" }),
				cwd: process.cwd(),
			});

			assert.equal(outcome.allowed, true);
			assert.equal(judge.calls.length, 0, "a read must not cost a Judge call");
		} finally {
			cleanup();
		}
	});

	test("MORE_EVIDENCE blocks the action and names what is missing", async () => {
		const { core, state, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({
				decision: "MORE_EVIDENCE",
				confidence: 0.94,
				reasons: ["Unit tests passed but regression verification is absent."],
				missingEvidence: ["s1: The test suite passes — not sufficiently supported (p=0.20)."],
			}),
		});
		try {
			const outcome = await core.gateAction({
				action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
				cwd: process.cwd(),
			});

			assert.equal(outcome.allowed, false, "the action must actually be blocked");
			assert.ok(outcome.message?.includes("BLOCKED"));
			assert.ok(outcome.message?.includes("Missing:"));
			assert.ok(outcome.message?.includes("s1"));
			assert.ok(outcome.message?.includes("Confidence:  0.94"));
			assert.ok(outcome.message?.includes("State:       v"));

			// The audit trail records the block with its reason (§19, §54).
			const s = state.getState();
			assert.equal(s.counters.blocks, 1);
			assert.equal(s.checkpoints[0]?.outcome, "blocked");
			assert.equal(s.decisions[0]?.decision, "MORE_EVIDENCE");
			assert.equal(s.decisions[0]?.applied, true);
		} finally {
			cleanup();
		}
	});

	test("FAIL blocks and signals that retrying unchanged is pointless", async () => {
		const { core, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({ decision: "FAIL", confidence: 0.97, reasons: ["A hard constraint would be violated."] }),
		});
		try {
			const outcome = await core.gateAction({
				action: action("bash", { command: "git push --force" }, "bash: publish the repository changes to the remote"),
				cwd: process.cwd(),
			});

			assert.equal(outcome.allowed, false);
			// No `terminate`: ending the run would only bounce through the completion gate
			// and back into the same FAIL. The message carries the instruction instead.
			assert.equal(outcome.terminate, undefined);
			assert.ok(outcome.message?.includes("Do not retry this action as-is"));
		} finally {
			cleanup();
		}
	});

	test("REVIEW asks the user, and their answer decides", async () => {
		for (const approves of [true, false]) {
			const { core, state, cleanup } = buildCore({
				c: gitPushContract,
				judgeResponse: () => ({ decision: "REVIEW", confidence: 0.5, reasons: ["Ambiguous."] }),
				confirm: async () => approves,
			});
			try {
				const outcome = await core.gateAction({
					action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
					cwd: process.cwd(),
				});

				assert.equal(outcome.allowed, approves);
				assert.ok(state.getState().checkpoints.length === 1);
			} finally {
				cleanup();
			}
		}
	});

	test("PASS allows the action and records it", async () => {
		const { core, state, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({ decision: "PASS", confidence: 0.96 }),
		});
		try {
			const outcome = await core.gateAction({
				action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
				cwd: process.cwd(),
			});

			assert.equal(outcome.allowed, true);
			assert.equal(state.getState().counters.blocks, 0);
			assert.equal(state.getState().checkpoints[0]?.outcome, "allowed");
		} finally {
			cleanup();
		}
	});

	test("the worker's own assessment is passed as untrusted and never as evidence (§38)", async () => {
		const { core, judge, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({ decision: "PASS", confidence: 0.9 }),
		});
		try {
			await core.gateAction({
				action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
				cwd: process.cwd(),
				agentAssessment: "Everything passed and this is completely safe.",
			});

			const payload = judge.calls[0]!.state;
			assert.ok(payload.agentAssessment?.startsWith("[UNTRUSTED"), "the worker's claim must be labelled untrusted");
			assert.equal(payload.evidence.length, 0, "an assertion must not become evidence");
		} finally {
			cleanup();
		}
	});
});

describe("The completion gate (§44)", () => {
	test("completion is rejected when success conditions are unverified", async () => {
		const { core, state, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({
				decision: "MORE_EVIDENCE",
				confidence: 1,
				missingEvidence: ["s1: The test suite passes — no runtime evidence has been collected."],
			}),
		});
		try {
			const outcome = await core.gateCompletion({ cwd: process.cwd() });

			assert.equal(outcome.allowed, false);
			assert.equal(outcome.resume, true, "the first rejection restarts the worker");
			assert.ok(outcome.message?.includes("COMPLETION REJECTED"));
			assert.ok(outcome.message?.includes("How to continue"));
			assert.ok(outcome.message?.includes("s1"));

			const s = state.getState();
			assert.equal(s.phase, "verify", "a rejected completion returns to verification, not completed");
			assert.equal(s.counters.completionAttempts, 1);
			assert.ok(s.lastCompletionFeedback?.includes("COMPLETION REJECTED"));
		} finally {
			cleanup();
		}
	});

	test("completion is accepted only after a PASS", async () => {
		const { core, state, cleanup } = buildCore({
			c: gitPushContract,
			judgeResponse: () => ({ decision: "PASS", confidence: 0.97 }),
		});
		try {
			const outcome = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(outcome.allowed, true);
			assert.equal(state.getState().phase, "completed");
		} finally {
			cleanup();
		}
	});

	test("a contract with nothing to verify still completes cleanly", async () => {
		const { core, state, cleanup } = buildCore({ c: contract({ goal: "say hello" }) });
		try {
			const outcome = await core.gateCompletion({ cwd: process.cwd() });
			assert.equal(outcome.allowed, true);
			assert.equal(state.getState().phase, "completed");
		} finally {
			cleanup();
		}
	});
});

describe("Evidence collection feeds the Judge", () => {
	test("an explicit typed command runs and its exit code becomes evidence", async () => {
		const executed: string[] = [];
		const exec: ExecFn = async (command, args) => {
			executed.push([command, ...args].join(" "));
			return { stdout: "3 passed", stderr: "", exitCode: 0 };
		};

		const { core, state, judge, cleanup } = buildCore({
			c: gitPushContract,
			exec,
			judgeResponse: () => ({ decision: "PASS", confidence: 0.95 }),
		});
		try {
			await core.gateAction({
				action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
				cwd: process.cwd(),
			});

			assert.deepEqual(executed, ["truetest"], "the command must come from the typed contract strategy");

			const evidence = state.getState().evidence;
			assert.equal(evidence.length, 1);
			assert.equal(evidence[0]?.trust, "runtime_evidence");
			assert.ok(evidence[0]?.summary.includes("exited 0"));

			// The Judge sees it, keyed by the requirement it bears on.
			const payload = judge.calls[0]!.state;
			assert.equal(payload.evidence.length, 1);
			assert.match(payload.evidence[0]?.result ?? "", /exited 0/);
		} finally {
			cleanup();
		}
	});

	test("a command containing shell metacharacters is refused", async () => {
		let ran = false;
		const exec: ExecFn = async () => {
			ran = true;
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const dangerous = contract({
			successConditions: [
				{
					id: "s1",
					description: "cleanup happened",
					source: "user",
					priority: "hard",
					verification: [
						{
							kind: "command_execution",
							program: "rm -rf / ; echo done",
							args: [],
							expectExitCode: 0,
						},
					],
					status: "pending",
				},
			],
			criticalActions: [{ id: "a1", description: "publish the output", source: "user", reversible: "no", requiresVerificationOf: ["s1"] }],
		});

		const { core, cleanup } = buildCore({ c: dangerous, exec, judgeResponse: () => ({ decision: "PASS" }) });
		try {
			await core.gateAction({
				action: action("bash", { command: "publish the output" }, "bash: publish the output"),
				cwd: process.cwd(),
			});
			assert.equal(ran, false, "the planner must not extract a chained shell command");
		} finally {
			cleanup();
		}
	});
});

describe("Pi adapter translation", () => {
	test("actions are summarized from argument shape, not a per-tool table", () => {
		assert.ok(summarize({ toolName: "bash", toolCallId: "1", input: { command: "ls -la" } }).includes("ls -la"));
		assert.ok(summarize({ toolName: "write", toolCallId: "1", input: { path: "a.ts", content: "x" } }).includes("write a.ts"));
		assert.ok(summarize({ toolName: "edit", toolCallId: "1", input: { path: "a.ts", edits: [] } }).includes("edit a.ts"));
		// An unknown custom tool is still described usefully.
		assert.ok(summarize({ toolName: "deploy_thing", toolCallId: "1", input: { url: "https://x.test/y" } }).includes("https://x.test/y"));
	});

	test("action signatures ignore volatile fields so loops are visible", () => {
		const a = signatureOf({ toolName: "read", toolCallId: "1", input: { path: "a.ts", offset: 0 } });
		const b = signatureOf({ toolName: "read", toolCallId: "2", input: { path: "a.ts", offset: 500 } });
		const c = signatureOf({ toolName: "read", toolCallId: "3", input: { path: "b.ts", offset: 0 } });

		assert.equal(a, b, "the same file at a different offset is the same approach");
		assert.notEqual(a, c);
	});

	test("a Pi tool_call event converts into a ProposedAction", () => {
		const converted = toProposedAction({ toolName: "bash", toolCallId: "call-1", input: { command: "make build" } });
		assert.equal(converted.id, "call-1");
		assert.equal(converted.toolName, "bash");
		assert.ok(converted.summary.includes("make build"));
		assert.ok(converted.signature.length > 0);
	});

	test("completion claims are recognised but never load-bearing", () => {
		assert.ok(extractCompletionClaim("All done! Tests pass and everything works."));
		assert.equal(extractCompletionClaim("Let me look at the next file."), undefined);
	});
});
