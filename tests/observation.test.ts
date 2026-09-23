import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createEvidenceCollector } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { buildJudgeQuery, workspaceChanges } from "../src/judges/payload.ts";
import { createJudgeRouter } from "../src/judges/router.ts";
import { createHarnessCore } from "../src/pi/harness.ts";
import { createProgressMonitor } from "../src/progress/monitor.ts";
import { resourceScope, createWorkspaceState } from "../src/resources/registry.ts";
import { describeDiff, diffSnapshots, snapshotTree } from "../src/resources/snapshot.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { nullLogger } from "../src/util/logger.ts";
import { action, contract, scriptedJudge, tempPaths, testConfig } from "./helpers.ts";

describe("Observation replaces inference: what a command did to the tree", () => {
	test("snapshot diff reports created, modified and deleted files and ignores .git and node_modules", () => {
		const paths = tempPaths();
		try {
			const root = paths.configDir;
			mkdirSync(join(root, "src"), { recursive: true });
			mkdirSync(join(root, ".git"), { recursive: true });
			mkdirSync(join(root, "node_modules", "x"), { recursive: true });
			writeFileSync(join(root, "src", "a.js"), "a");
			writeFileSync(join(root, "src", "b.js"), "b");
			writeFileSync(join(root, ".git", "HEAD"), "ref");
			const before = snapshotTree(root);
			writeFileSync(join(root, "src", "a.js"), "a2");
			rmSync(join(root, "src", "b.js"));
			writeFileSync(join(root, "c.md"), "c");
			writeFileSync(join(root, ".git", "index"), "idx");
			writeFileSync(join(root, "node_modules", "x", "i.js"), "m");
			const diff = diffSnapshots(before, snapshotTree(root));
			assert.deepEqual(diff, { created: ["c.md"], modified: ["src/a.js"], deleted: ["src/b.js"], truncated: false });
			assert.match(describeDiff(diff), /created c\.md; modified src\/a\.js; deleted src\/b\.js/);
		} finally {
			paths.cleanup();
		}
	});

	test("an observed diff becomes workspace truth: produced files, judge state and reviewer sources", async () => {
		const paths = tempPaths();
		try {
			const root = paths.configDir;
			const c = contract({
				metadata: { createdAt: new Date().toISOString(), cwd: root },
				successConditions: [{ id: "s1", description: "report.md summarizes the run", source: "user", priority: "hard", status: "pending", verification: [] }],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const judge = scriptedJudge(() => ({ decision: "PASS", confidence: 0.9 }));
			const config = testConfig();
			let prompt = "";
			const core = createHarnessCore({
				config,
				paths,
				state,
				detector: createCheckpointDetector({ config, judge }),
				planner: createEvidencePlanner(),
				collector: createEvidenceCollector({
					reviewer: { id: "stub/r", available: true, async complete(r) { prompt = r.userPrompt; return { text: "VERIFIED — it does.", model: "stub/r" }; } },
				}),
				judge: createJudgeRouter({ primary: judge, fallbacks: [], config: config.judge }),
				progress: createProgressMonitor({ config }),
				logger: nullLogger,
			});

			// A shell command the classifier cannot see through writes the report.
			const cmd = action("bash", { command: "python3 gen.py" });
			state.recordProposedAction({ ...cmd, at: new Date().toISOString(), stateVersion: state.getVersion(), outcome: "pending" });
			state.recordAllowed(cmd.id);
			writeFileSync(join(root, "report.md"), "# Run\nAll good.\n");
			core.recordToolResult({
				actionId: cmd.id,
				summary: "done",
				isError: false,
				observed: { created: ["report.md"], modified: [], deleted: [], truncated: false },
			});

			const resources = state.getState().workspace.resources;
			assert.equal(resources.length, 1);
			assert.equal(resources[0]?.provenance, "created_by_current_task");
			assert.match(state.getState().actions[0]?.resultSummary ?? "", /observed in the workspace after the command: created report\.md/);

			assert.deepEqual(workspaceChanges(state.getState()), { created: ["report.md"], modified: [], deleted: [] });
			const query = buildJudgeQuery({
				contract: c,
				state: state.getState(),
				checkpoint: { needsGate: true, checkpointType: "completion_claim", severity: "critical", reason: "completion", signals: [], relatedRequirements: ["s1"], escalated: false },
				action: action("bash", { command: "true" }),
			});
			assert.deepEqual(query.state.workspaceChanges.created, ["report.md"]);

			// The reviewer reads the observed file, so a prose condition is settled from content.
			const outcome = await core.gateCompletion({ cwd: root });
			assert.equal(outcome.allowed, true);
			assert.ok(prompt.includes("All good."), "the reviewer saw the file the command produced");
		} finally {
			paths.cleanup();
		}
	});

	test("a path with unexpanded shell syntax has unknown scope, never 'outside the workspace'", () => {
		const ws = createWorkspaceState("/workspace/app");
		assert.equal(resourceScope("file:///workspace/app/$BAD", ws), "unknown");
		assert.equal(resourceScope("file:///workspace/app/%7Boops", ws), "unknown");
		assert.equal(resourceScope("file:///etc/passwd", ws), "outside_allowed");
		assert.equal(resourceScope("file:///workspace/app/src/x.js", ws), "allowed");
	});
});
