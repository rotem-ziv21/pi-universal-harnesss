import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { createEvidencePlanner } from "../src/evidence/planner.ts";
import { buildJudgeQuery } from "../src/judges/payload.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { action, contract, testConfig } from "./helpers.ts";

/**
 * §60 — the same harness across three unrelated workflows.
 *
 * The point of these tests is not that each one passes. It is that all three pass
 * through *identical* harness code, with the only difference being the contract
 * content. If someone later adds a coding-specific branch to the detector or planner,
 * the dataset and image tests are what will catch it.
 */

const config = testConfig();

const setup = (c: ReturnType<typeof contract>) => {
	const state = createStateManager(c.id, c, { persist: false });
	state.lockContract(c);
	return {
		state,
		detector: createCheckpointDetector({ config }),
		planner: createEvidencePlanner(),
	};
};

// ---------------------------------------------------------------------------

describe("A. Coding workflow", () => {
	const coding = contract({
		id: "task-coding",
		originalRequest: "Modify feature X. Do not modify file Y. Run tests. Only push after verification.",
		goal: "Modify feature X safely",
		requirements: [
			{ id: "r1", description: "Feature X behaves as requested", source: "user", priority: "hard", status: "pending" },
		],
		constraints: [
			{
				id: "c1",
				description: "The file Y must not be modified",
				source: "user",
				priority: "hard",
				quote: "Do not modify file Y",
				check: { kind: "path_unmodified", target: "src/Y.ts" },
			},
		],
		successConditions: [
			{
				id: "s1",
				description: "The test suite passes",
				source: "user",
				priority: "hard",
				verificationHint: "run `npm test`",
				status: "pending",
			},
		],
		criticalActions: [
			{
				id: "a1",
				description: "Publish the repository changes to the shared remote",
				source: "user",
				rationale: "The user gated this on verification",
				reversible: "no",
				requiresVerificationOf: ["s1"],
			},
		],
	});

	test("captures the hard user constraint verbatim, without softening it", () => {
		const c1 = coding.constraints[0]!;
		assert.equal(c1.source, "user");
		assert.equal(c1.priority, "hard");
		assert.equal(c1.quote, "Do not modify file Y");
	});

	test("reading a file is not gated", async () => {
		const { detector, state } = setup(coding);
		const decision = await detector.evaluate({
			contract: coding,
			state: state.getState(),
			action: action("read", { path: "src/feature-x.ts" }),
		});
		assert.equal(decision.needsGate, false, "a read must take the fast path with no Judge call");
	});

	test("the contract's critical action is detected on the matching proposal", async () => {
		const { detector, state } = setup(coding);
		const decision = await detector.evaluate({
			contract: coding,
			state: state.getState(),
			action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
		});

		assert.equal(decision.needsGate, true);
		assert.equal(decision.severity, "critical");
		assert.equal(decision.checkpointType, "contract_critical_action");
		assert.ok(decision.relatedRequirements.includes("a1"));
		assert.ok(decision.relatedRequirements.includes("s1"), "should pull in what the contract said to verify first");
	});

	test("touching the protected path trips the hard constraint", async () => {
		const { detector, state } = setup(coding);
		const decision = await detector.evaluate({
			contract: coding,
			state: state.getState(),
			action: action("write", { path: "src/Y.ts", content: "changed" }),
		});

		assert.equal(decision.needsGate, true);
		assert.equal(decision.checkpointType, "constraint_risk");
		assert.ok(decision.relatedRequirements.includes("c1"));
	});

	test("the planner derives the test command from the contract's own hint", async () => {
		const { detector, planner, state } = setup(coding);
		const checkpoint = await detector.evaluate({
			contract: coding,
			state: state.getState(),
			action: action("bash", { command: "git push origin main" }, "bash: publish the repository changes to the remote"),
		});

		const plan = planner.plan({
			contract: coding,
			state: state.getState(),
			checkpoint,
			checkpointId: "ckpt-1",
			action: action("bash", { command: "git push" }),
		});

		const commands = plan.evidenceRequests.filter((r) => r.kind === "command").map((r) => r.parameters.command);
		assert.ok(commands.includes("npm test"), `expected 'npm test' to be derived, got ${JSON.stringify(commands)}`);
	});
});

// ---------------------------------------------------------------------------

describe("B. Dataset workflow", () => {
	const dataset = contract({
		id: "task-dataset",
		originalRequest: "Prepare classification dataset. Do not modify source. Ensure no train/validation leakage.",
		goal: "Produce a training-ready classification dataset",
		constraints: [
			{
				id: "c1",
				description: "The original source dataset must remain unchanged",
				source: "user",
				priority: "hard",
				quote: "Do not modify source",
				check: { kind: "hash_unchanged", target: "data/source" },
			},
		],
		forbiddenConditions: [
			{
				id: "f1",
				description: "Any sample appears in both the train and validation splits",
				source: "user",
				priority: "hard",
			},
		],
		successConditions: [
			{
				id: "s1",
				description: "Train and validation splits are disjoint",
				source: "user",
				priority: "hard",
				verificationHint: "run `python check_leakage.py`",
				status: "pending",
			},
		],
		criticalActions: [
			{
				id: "a1",
				description: "Write over or finalize the dataset on disk",
				source: "compiler",
				reversible: "no",
				requiresVerificationOf: ["s1"],
			},
		],
	});

	test("the identical detector gates a dataset action, with no coding assumptions", async () => {
		const { detector, state } = setup(dataset);
		const decision = await detector.evaluate({
			contract: dataset,
			state: state.getState(),
			action: action("write", { path: "data/source/labels.csv", content: "…" }),
		});

		assert.equal(decision.needsGate, true);
		assert.ok(decision.relatedRequirements.includes("c1"), "the source-dataset constraint must be implicated");
		// Nothing about tests, git or branches should appear anywhere.
		assert.ok(!JSON.stringify(decision).toLowerCase().includes("git"));
		assert.ok(!JSON.stringify(decision).toLowerCase().includes("test"));
	});

	test("the planner derives a dataset-specific check, not a test runner", () => {
		const { detector: _d, planner, state } = setup(dataset);

		const plan = planner.plan({
			contract: dataset,
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
			action: action("write", { path: "data/out/train.csv", content: "…" }),
		});

		const commands = plan.evidenceRequests.filter((r) => r.kind === "command").map((r) => r.parameters.command);
		assert.ok(commands.includes("python check_leakage.py"));

		// The hash-unchanged constraint becomes a file_state check with no command.
		const fileChecks = plan.evidenceRequests.filter((r) => r.kind === "file_state");
		assert.ok(fileChecks.some((r) => r.parameters.path === "data/source"));
	});

	test("forbidden conditions reach the Judge payload", () => {
		const { state } = setup(dataset);
		const query = buildJudgeQuery({
			contract: dataset,
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
			action: action("write", { path: "data/out/train.csv", content: "…" }),
		});

		assert.ok(query.state.forbiddenConditions.some((f) => f.includes("both the train and validation splits")));
	});
});

// ---------------------------------------------------------------------------

describe("C. Creative / image workflow", () => {
	const image = contract({
		id: "task-image",
		originalRequest: "Create an image containing the exact text 'Ship it safely' on the left.",
		goal: "Produce the requested visual",
		requirements: [
			{
				id: "r1",
				description: "The image contains the exact text 'Ship it safely'",
				source: "user",
				priority: "hard",
				quote: "the exact text 'Ship it safely'",
				status: "pending",
			},
			{
				id: "r2",
				description: "That text appears on the left side of the image",
				source: "user",
				priority: "hard",
				quote: "on the left",
				status: "pending",
			},
			{ id: "r3", description: "The image is visually appealing", source: "compiler", priority: "soft", status: "pending" },
		],
		successConditions: [
			{
				id: "s1",
				description: "Text recognised in the image matches 'Ship it safely' exactly",
				source: "user",
				priority: "hard",
				verificationHint: "Text extracted from the generated image is compared character by character",
				status: "pending",
			},
			{
				id: "s2",
				description: "The recognised text is positioned in the left portion of the image",
				source: "user",
				priority: "hard",
				verificationHint: "The text bounding box centre falls in the left half of the image",
				status: "pending",
			},
		],
	});

	test("the contract represents exact text, placement, semantics and hard/soft split", () => {
		assert.equal(image.requirements.filter((r) => r.priority === "hard").length, 2);
		assert.equal(image.requirements.filter((r) => r.priority === "soft").length, 1);
		assert.ok(image.requirements.some((r) => r.description.includes("'Ship it safely'")));
		assert.ok(image.requirements.some((r) => r.description.includes("left side")));
	});

	test("unverifiable-by-command requirements become reviewer requests, not silent gaps", () => {
		const { planner, state } = setup(image);

		const plan = planner.plan({
			contract: image,
			state: state.getState(),
			checkpoint: {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "completion",
				signals: [],
				relatedRequirements: [],
				escalated: false,
			},
			checkpointId: "ckpt-1",
			action: action("generate_image", { prompt: "kubernetes" }),
		});

		const reviewerRequests = plan.evidenceRequests.filter((r) => r.kind === "reviewer");
		assert.ok(reviewerRequests.length >= 2, "OCR and layout checks have no derivable command, so they must go to a reviewer");
		assert.ok(reviewerRequests.every((r) => r.necessity === "required"));
	});

	test("soft requirements do not block; hard ones do", () => {
		const { planner, state } = setup(image);

		const plan = planner.plan({
			contract: image,
			state: state.getState(),
			checkpoint: {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "completion",
				signals: [],
				relatedRequirements: [],
				escalated: false,
			},
			checkpointId: "ckpt-1",
			action: action("generate_image", { prompt: "kubernetes" }),
		});

		// r3 is soft and has no verification hint, so it is neither planned nor required.
		assert.ok(!plan.requirementsToVerify.includes("r3"));
	});
});

// ---------------------------------------------------------------------------

describe("Cross-workflow: the harness is genuinely task-agnostic", () => {
	test("core gating logic contains no domain-specific rules", async () => {
		const { readFileSync } = await import("node:fs");

		/**
		 * Comments are stripped before checking. Several of these files *discuss* git
		 * precisely to explain why they do not branch on it, and a test that failed on
		 * the explanation would push us to delete the explanation rather than keep the
		 * property. What matters is that no executable line encodes a domain rule.
		 */
		const stripComments = (source: string): string =>
			source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.split("\n")
				.filter((line) => !/^\s*(\/\/|\*)/.test(line))
				.join("\n");

		const files = ["checkpoints/detector.ts", "checkpoints/signals.ts", "evidence/planner.ts", "judges/payload.ts"];

		for (const file of files) {
			const code = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));

			// §65.8 — no hardcoded git workflow in universal core logic.
			assert.ok(!/\bgit\b/.test(code), `${file} must not reference git in executable code`);
			assert.ok(!/\bnpm\b|\bpytest\b|\bcargo\b/.test(code), `${file} must not reference a specific build or test tool`);
			assert.ok(!/toolName\s*===\s*["']/.test(code), `${file} must not branch on a specific tool name`);
			assert.ok(!/\bdataset\b|\bOCR\b/i.test(code), `${file} must not reference a specific task domain`);
		}
	});

	test("all three contracts share one schema and differ only in content", () => {
		const shapes = [
			contract({ id: "a" }),
			contract({ id: "b", requirements: [{ id: "r1", description: "x", source: "user", priority: "hard", status: "pending" }] }),
		].map((c) => Object.keys(c).sort().join(","));

		assert.equal(shapes[0], shapes[1]);
	});
});

describe("Repository completeness", () => {
	/**
	 * Regression test for a bug that only appeared on other people's machines.
	 *
	 * `.gitignore` contained the unanchored pattern `state/`, which matched
	 * `src/state/` as well as the intended local state directory. The whole
	 * canonical-state module was therefore never committed. Everything worked where
	 * it was authored — the files exist there, merely untracked — and every fresh
	 * clone died at startup with "Cannot find module '../state/freshness.ts'".
	 *
	 * Type-checking and unit tests both passed throughout, because they read the
	 * working tree rather than the repository. Only git knows the difference.
	 */
	test("every source file the harness imports is tracked in git", async () => {
		const { execFileSync } = await import("node:child_process");
		const { readdirSync, statSync } = await import("node:fs");
		const { join, relative } = await import("node:path");

		const root = new URL("..", import.meta.url).pathname;

		let tracked: Set<string>;
		try {
			const output = execFileSync("git", ["ls-files", "src", "tests", "index.ts", "scripts"], {
				cwd: root,
				encoding: "utf8",
			});
			tracked = new Set(output.split("\n").filter(Boolean));
		} catch {
			return; // Not a git checkout (e.g. installed as a package copy); nothing to assert.
		}

		const onDisk: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules" || entry.startsWith(".")) continue;
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.(ts|sh)$/.test(entry)) onDisk.push(relative(root, full));
			}
		};
		walk(join(root, "src"));
		walk(join(root, "tests"));
		walk(join(root, "scripts"));

		const untracked = onDisk.filter((f) => !tracked.has(f));

		assert.deepEqual(
			untracked,
			[],
			`These source files exist on disk but are NOT in git, so a fresh clone would be broken:\n  ${untracked.join("\n  ")}\n` +
				"Check .gitignore for an unanchored pattern.",
		);
	});
});
