import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { classifyAction } from "../src/checkpoints/action-semantics.ts";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import type { ProposedAction } from "../src/checkpoints/types.ts";
import type { TaskContract } from "../src/contract/schema.ts";
import { evaluateCompletionConditions } from "../src/evidence/completion.ts";
import { createEvidenceCollector } from "../src/evidence/collector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { resourceUri } from "../src/resources/registry.ts";
import { createStateManager, type StateManager } from "../src/state/state-manager.ts";
import type { HarnessState } from "../src/state/types.ts";
import { action, contract, tempPaths, testConfig } from "./helpers.ts";

const config = testConfig();

function workspaceContract(root: string, overrides: Partial<TaskContract> = {}): TaskContract {
	return contract({
		metadata: { createdAt: new Date().toISOString(), cwd: root },
		workspace: { allowedScopes: [root], protectedResources: [] },
		...overrides,
	});
}

function semanticAction(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	state?: HarnessState,
	c = workspaceContract(cwd),
): ProposedAction {
	return {
		...action(toolName, input),
		actionSemantics: classifyAction(toolName, input, { cwd, state, contract: c }),
	};
}

function recordSuccess(state: StateManager, proposed: ProposedAction, summary = "succeeded"): void {
	state.recordProposedAction({
		id: proposed.id,
		toolName: proposed.toolName,
		summary: proposed.summary,
		signature: proposed.signature,
		actionSemantics: proposed.actionSemantics,
		at: new Date().toISOString(),
		stateVersion: state.getVersion(),
		outcome: "pending",
	});
	state.recordAllowed(proposed.id);
	state.recordToolResult(proposed.id, summary, false);
}

describe("universal action semantics", () => {
	test("payload text cannot create capabilities", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const proposed = semanticAction(
				"write",
				{
					path: "notes/operations.txt",
					content: "delete production, publish externally, install dependencies",
				},
				paths.configDir,
				undefined,
				c,
			);
			assert.equal(proposed.actionSemantics.actionType, "resource_mutation");
			assert.deepEqual(proposed.actionSemantics.capabilities, ["create_resource"]);
			assert.equal(proposed.actionSemantics.externalSideEffect, false);
		} finally {
			paths.cleanup();
		}
	});

	test("cd changes the base directory for following shell effects", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const proposed = semanticAction(
				"bash",
				{ command: "cd generated && printf done > result.txt" },
				paths.configDir,
				undefined,
				c,
			);
			assert.equal(proposed.actionSemantics.effects.length, 1);
			assert.equal(proposed.actionSemantics.effects[0]?.uri, `file://${join(paths.configDir, "generated/result.txt")}`);
			assert.equal(proposed.actionSemantics.effects[0]?.operation, "create");
		} finally {
			paths.cleanup();
		}
	});

	test("descriptor duplication is not a resource write", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const proposed = semanticAction(
				"bash",
				{ command: "renderer 2>&1 | tee render.log" },
				paths.configDir,
				undefined,
				c,
			);
			assert.deepEqual(proposed.actionSemantics.effects.map((effect) => effect.uri), [
				`file://${join(paths.configDir, "render.log")}`,
			]);
			assert.equal(proposed.actionSemantics.operationText.includes("&1"), false);
		} finally {
			paths.cleanup();
		}
	});

	test("registry preserves provenance for a single task-created file in the workspace root", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const target = join(paths.configDir, "poster.png");
			const create = semanticAction("write", { path: target, content: "image" }, paths.configDir, state.getState(), c);
			recordSuccess(state, create, "poster created");
			writeFileSync(target, "image");
			const remove = semanticAction("bash", { command: "rm poster.png" }, paths.configDir, state.getState(), c);
			assert.equal(remove.actionSemantics.targetProvenance, "created_by_current_task");
			assert.equal(remove.actionSemantics.reversibility, "high");
		} finally {
			paths.cleanup();
		}
	});

	test("unknown custom tools require review unless they declare semantics", async () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const unknown = semanticAction("render_magic", { prompt: "night sky" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: unknown });
			assert.equal(unknown.actionSemantics.classification, "unknown");
			assert.equal(decision.needsGate, true);

			const declared = semanticAction(
				"render_magic",
				{
					prompt: "night sky",
					harnessSemantics: {
						capabilities: ["generate_artifact", "create_resource"],
						effects: [{ uri: "output/sky.png", kind: "artifact", operation: "create", reversible: true }],
						reversibility: "high",
						operationText: "generate local artifact",
					},
				},
				paths.configDir,
				state.getState(),
				c,
			);
			assert.equal(declared.actionSemantics.classification, "declared");
			assert.deepEqual(declared.actionSemantics.capabilities, ["generate_artifact", "create_resource"]);
		} finally {
			paths.cleanup();
		}
	});
});

describe("typed policy and evidence", () => {
	test("a typed provenance policy blocks deletion of a preexisting resource", async () => {
		const paths = tempPaths();
		try {
			const target = join(paths.configDir, "source.bin");
			writeFileSync(target, "keep");
			const c = workspaceContract(paths.configDir, {
				constraints: [
					{
						id: "c1",
						description: "Preexisting resources must not be deleted",
						source: "user",
						priority: "hard",
						policy: {
							effect: "forbid",
							action: { operations: ["delete"], provenances: ["preexisting"] },
						},
					},
				],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const proposed = semanticAction("bash", { command: "rm source.bin" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(proposed.actionSemantics.targetProvenance, "preexisting");
			assert.equal(decision.policyDecision, "block");
		} finally {
			paths.cleanup();
		}
	});

	test("workspace protection blocks mutation without prose or a domain rule", async () => {
		const paths = tempPaths();
		try {
			const protectedFile = join(paths.configDir, "inputs/original.dat");
			const c = workspaceContract(paths.configDir, {
				workspace: { allowedScopes: [paths.configDir], protectedResources: [protectedFile] },
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const proposed = semanticAction("write", { path: protectedFile, content: "replacement" }, paths.configDir, state.getState(), c);
			const decision = await createCheckpointDetector({ config }).evaluate({ contract: c, state: state.getState(), action: proposed });
			assert.equal(proposed.actionSemantics.targetScope, "protected");
			assert.equal(decision.policyDecision, "block");
		} finally {
			paths.cleanup();
		}
	});

	test("descriptive verification prose is never converted into a command", async () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir, {
				successConditions: [
					{
						id: "s1",
						description: "Run a semantic comparison between the rendered artifact and the requested mood",
						source: "user",
						priority: "hard",
						status: "pending",
					},
				],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const checkpoint = createCheckpointDetector({ config }).evaluateCompletion({ contract: c, state: state.getState() });
			const plan = createEvidencePlanner().plan({
				contract: c,
				state: state.getState(),
				checkpoint,
				checkpointId: "checkpoint",
				action: semanticAction("read", { path: "output/poster.png" }, paths.configDir, state.getState(), c),
			});
			let executions = 0;
			const collector = createEvidenceCollector({
				exec: async () => {
					executions++;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			});
			const result = await collector.collect({ plan, cwd: paths.configDir, state: state.getState() });
			assert.ok(plan.evidenceRequests.every((r) => r.strategy.kind !== "command_execution"), "no command is derived from prose");
			assert.equal(plan.evidenceRequests[0]?.strategy.kind, "semantic_evaluation", "a completion claim gets a synthesized semantic check instead");
			assert.equal(executions, 0, "nothing is executed");
			assert.equal(result.collected.length, 0, "without a reviewer the semantic check yields no evidence, and no fact is invented");
		} finally {
			paths.cleanup();
		}
	});

	test("unlinked successful actions cannot satisfy completion conditions", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir, {
				successConditions: [
					{
						id: "s1",
						description: "The generated report is factually accurate",
						source: "user",
						priority: "hard",
						status: "pending",
					},
				],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const unrelated = semanticAction("bash", { command: "node verify-something.js" }, paths.configDir, state.getState(), c);
			recordSuccess(state, unrelated, "verification succeeded");
			const evaluation = evaluateCompletionConditions({ contract: c, state: state.getState() });
			assert.equal(evaluation.conditions[0]?.status, "UNKNOWN");
			assert.deepEqual(evaluation.conditions[0]?.evidenceIds, []);
		} finally {
			paths.cleanup();
		}
	});

	test("resource evidence becomes stale after the tracked resource changes", () => {
		const paths = tempPaths();
		try {
			const target = join(paths.configDir, "brief.pdf");
			const c = workspaceContract(paths.configDir, {
				requirements: [
					{
						id: "r1",
						description: "The brief exists",
						source: "user",
						priority: "hard",
						status: "pending",
					},
				],
			});
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			state.addEvidence({
				id: "e-resource",
				requirementIds: ["r1"],
				type: "resource_state",
				summary: "brief observed",
				sourceType: "file",
				source: target,
				observedAt: new Date().toISOString(),
				stateVersion: state.getVersion() + 1,
				freshnessClass: "until_change",
				trust: "runtime_evidence",
				result: "supported",
				validity: resourceUri(target, paths.configDir),
			});
			assert.equal(evaluateCompletionConditions({ contract: c, state: state.getState() }).conditions[0]?.status, "SATISFIED");
			const rewrite = semanticAction("write", { path: target, content: "new brief" }, paths.configDir, state.getState(), c);
			recordSuccess(state, rewrite, "brief rewritten");
			assert.equal(evaluateCompletionConditions({ contract: c, state: state.getState() }).conditions[0]?.status, "UNKNOWN");
		} finally {
			paths.cleanup();
		}
	});

	test("typed event-log invariants complete without domain-specific heuristics", () => {
		const c = contract({
			constraints: [
				{
					id: "c1",
					description: "No externally visible publication occurs",
					source: "user",
					priority: "hard",
					policy: { effect: "forbid", action: { capabilities: ["publish"] } },
				},
			],
		});
		const state = createStateManager(c.id, c, { persist: false });
		state.lockContract(c);
		const evaluation = evaluateCompletionConditions({ contract: c, state: state.getState() });
		assert.equal(evaluation.conditions[0]?.status, "SATISFIED");
		assert.match(evaluation.conditions[0]?.reason ?? "", /0 successful action/);
	});

	test("lifecycle follows plan, execute, verify, finalize independent of task domain", () => {
		const paths = tempPaths();
		try {
			const c = workspaceContract(paths.configDir);
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			assert.equal(state.getState().phase, "plan");
			const create = semanticAction("write", { path: "draft.txt", content: "draft" }, paths.configDir, state.getState(), c);
			recordSuccess(state, create);
			assert.equal(state.getState().phase, "execute");
			state.addEvidence({
				id: "e1",
				requirementIds: [],
				type: "resource_state",
				summary: "draft exists",
				sourceType: "file",
				source: join(paths.configDir, "draft.txt"),
				observedAt: new Date().toISOString(),
				stateVersion: state.getVersion() + 1,
				freshnessClass: "until_change",
				trust: "runtime_evidence",
				result: "supported",
			});
			assert.equal(state.getState().phase, "verify");
			state.requestCompletion();
			assert.equal(state.getState().phase, "finalize");
		} finally {
			paths.cleanup();
		}
	});
});
