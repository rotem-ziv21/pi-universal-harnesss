import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import type { ProposedAction } from "../src/checkpoints/types.ts";
import type { HarnessPaths } from "../src/config/paths.ts";
import type { TaskContract } from "../src/contract/schema.ts";
import { createEvidenceCollector, type ExecFn } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createHarnessCore } from "../src/pi/harness.ts";
import { createProgressMonitor } from "../src/progress/monitor.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { nullLogger } from "../src/util/logger.ts";
import { action, contract, recordWork, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

const config = testConfig();

function crossDomainContract(root: string, overrides: Partial<TaskContract>): TaskContract {
	return contract({
		metadata: { createdAt: new Date().toISOString(), cwd: root },
		workspace: { allowedScopes: [root], protectedResources: [] },
		...overrides,
	});
}

function createCore(c: TaskContract, paths: HarnessPaths, exec?: ExecFn) {
	const state = createStateManager(c.id, c, { persist: false });
	state.lockContract(c);
	const judge = scriptedJudge(() => ({ decision: "PASS", confidence: 0.99 }));
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

function declaredArtifactAction(path: string): ProposedAction {
	return action("artifact_renderer", {
		prompt: "A calm blue cover with strong hierarchy",
		harnessSemantics: {
			capabilities: ["generate_artifact", "create_resource"],
			effects: [{ uri: path, kind: "artifact", operation: "create", reversible: true }],
			reversibility: "high",
			operationText: "generate local artifact",
		},
	});
}

describe("A. local file and code workflow", () => {
	test("local construction is allowed and explicit argv verification completes the task", async () => {
		const paths = tempPaths();
		const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
		const exec: ExecFn = async (program, args, options) => {
			calls.push({ program, args, cwd: options.cwd });
			return { stdout: "all checks passed", stderr: "", exitCode: 0 };
		};
		const c = crossDomainContract(paths.configDir, {
			successConditions: [
				{
					id: "s1",
					description: "The local verification program reports success",
					source: "user",
					priority: "hard",
					status: "pending",
					verification: [
						{
							kind: "command_execution",
							program: "node",
							args: ["tools/verify-widget.mjs", "dist/widget.bin"],
							expectExitCode: 0,
							stdout: { operator: "contains", value: "checks passed" },
						},
					],
				},
			],
		});
		const { core, judge, state } = createCore(c, paths, exec);
		try {
			const create = action("write", { path: join(paths.configDir, "src/widget.ts"), content: "export const widget = 1;" });
			const gate = await core.gateAction({ action: create, cwd: paths.configDir });
			assert.equal(gate.allowed, true);
			core.recordToolResult({ actionId: create.id, summary: "widget source written", isError: false });
			const completion = await core.gateCompletion({ cwd: paths.configDir });
			assert.equal(completion.allowed, true);
			assert.deepEqual(calls, [
				{ program: "node", args: ["tools/verify-widget.mjs", "dist/widget.bin"], cwd: paths.configDir },
			]);
			assert.equal(judge.calls.length, 0);
			assert.equal(state.getState().evidence[0]?.result, "supported");
			assert.equal(state.getState().evidence[0]?.provenance, "explicit_contract_strategy");
		} finally {
			paths.cleanup();
		}
	});
});

describe("B. protected-source transformation workflow", () => {
	test("output construction proceeds while typed scope policy blocks source mutation", async () => {
		const paths = tempPaths();
		const source = join(paths.configDir, "source-records");
		const output = join(paths.configDir, "prepared-records");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "input.json"), "{}\n");
		const c = crossDomainContract(paths.configDir, {
			workspace: { allowedScopes: [paths.configDir], protectedResources: [source] },
			constraints: [
				{
					id: "c1",
					description: "Source records remain unchanged",
					source: "user",
					priority: "hard",
					policy: {
						effect: "forbid",
						action: { operations: ["create", "modify", "delete", "move"], scopes: ["protected"] },
					},
				},
			],
		});
		const { core, judge } = createCore(c, paths);
		try {
			const createOutput = action("write", { path: join(output, "result.json"), content: "{}\n" });
			const outputGate = await core.gateAction({ action: createOutput, cwd: paths.configDir });
			assert.equal(outputGate.allowed, true);

			const mutateSource = action("write", { path: join(source, "input.json"), content: '{"changed":true}\n' });
			const sourceGate = await core.gateAction({ action: mutateSource, cwd: paths.configDir });
			assert.equal(sourceGate.allowed, false);
			assert.equal(sourceGate.checkpoint?.policyDecision, "block");
			assert.equal(judge.calls.length, 0);
		} finally {
			paths.cleanup();
		}
	});
});

describe("C. non-code artifact workflow", () => {
	test("declared generator semantics and resource-state evidence handle a simulated image", async () => {
		const paths = tempPaths();
		const image = join(paths.configDir, "renders/cover.png");
		const c = crossDomainContract(paths.configDir, {
			successConditions: [
				{
					id: "s1",
					description: "The rendered cover exists",
					source: "user",
					priority: "hard",
					status: "pending",
					verification: [{ kind: "resource_state", resource: image, condition: "exists" }],
				},
			],
		});
		const { core, judge, state } = createCore(c, paths);
		try {
			const proposed = declaredArtifactAction(image);
			const gate = await core.gateAction({ action: proposed, cwd: paths.configDir });
			assert.equal(gate.allowed, true);
			mkdirSync(join(paths.configDir, "renders"), { recursive: true });
			writeFileSync(image, "simulated image bytes");
			core.recordToolResult({ actionId: proposed.id, summary: "cover rendered", isError: false });
			const completion = await core.gateCompletion({ cwd: paths.configDir });
			assert.equal(completion.allowed, true);
			assert.equal(judge.calls.length, 0);
			assert.equal(state.getState().workspace.resources[0]?.kind, "artifact");
			assert.equal(state.getState().workspace.resources[0]?.provenance, "created_by_current_task");
		} finally {
			paths.cleanup();
		}
	});
});

describe("D. gated external action workflow", () => {
	test("publication gates on capability and collects linked resource evidence first", async () => {
		const paths = tempPaths();
		const artifact = join(paths.configDir, "release/package.bin");
		mkdirSync(join(paths.configDir, "release"), { recursive: true });
		writeFileSync(artifact, "package");
		const c = crossDomainContract(paths.configDir, {
			successConditions: [
				{
					id: "s1",
					description: "The publication artifact exists",
					source: "user",
					priority: "hard",
					status: "pending",
					verification: [{ kind: "resource_state", resource: artifact, condition: "exists" }],
				},
			],
			criticalActions: [
				{
					id: "a1",
					description: "Publish an artifact to an external destination",
					source: "user",
					reversible: "no",
					requiresVerificationOf: ["s1"],
					action: { capabilities: ["publish"], externalSideEffect: true },
				},
			],
		});
		const { core, judge, state } = createCore(c, paths);
		try {
			const publish = action("bash", { command: "git push origin release" });
			const result = await core.gateAction({ action: publish, cwd: paths.configDir });
			assert.equal(result.allowed, true);
			assert.equal(result.checkpoint?.checkpointType, "contract_critical_action");
			assert.equal(judge.calls.length, 1);
			assert.equal(state.getState().evidence[0]?.requirementIds[0], "s1");
			assert.equal(state.getState().evidence[0]?.result, "supported");
		} finally {
			paths.cleanup();
		}
	});
});

describe("CSV reproduction paired with unrelated verification", () => {
	test("empty-table verification uses typed numeric output rather than filename heuristics", async () => {
		const paths = tempPaths();
		const c = crossDomainContract(paths.configDir, {
			successConditions: [
				{
					id: "s1",
					description: "The transformed table contains zero data rows",
					source: "user",
					priority: "hard",
					status: "pending",
					verification: [
						{
							kind: "command_execution",
							program: "python3",
							args: ["tools/count_rows.py", "result.csv"],
							expectExitCode: 0,
							stdout: { operator: "numeric_equals", value: "0" },
						},
					],
				},
			],
		});
		const { core, judge, state } = createCore(c, paths, async () => ({ stdout: "0\n", stderr: "", exitCode: 0 }));
		try {
			recordWork(state);
			const completion = await core.gateCompletion({ cwd: paths.configDir });
			assert.equal(completion.allowed, true);
			assert.equal(judge.calls.length, 0);
		} finally {
			paths.cleanup();
		}
	});
});
