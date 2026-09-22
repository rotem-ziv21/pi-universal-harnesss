import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { EvidencePlan } from "../evidence/types.ts";
import type { RoutedDecision } from "../judges/router.ts";
import { describeContractItem } from "../contract/schema.ts";
import type { CompletionEvaluation, HarnessState } from "../state/types.ts";
import { displayPath } from "../config/paths.ts";
import { clamp } from "../util/json.ts";

/**
 * Explainability (§54).
 *
 * When the harness blocks something, the user is owed a complete answer — not
 * "blocked by policy". Every block shows the action, the checkpoint, the contract
 * item behind it, what evidence exists, what is missing, which Judge decided, its
 * confidence, and the state version.
 *
 * Plain text, because this is rendered into a terminal and into the message the
 * worker model receives. No ANSI escapes: Pi owns the theme, and the same string has
 * to read correctly in a TUI, in a log, and in an LLM's context.
 */

export function renderBlock(args: {
	action: ProposedAction;
	checkpoint: CheckpointDecision;
	decision: RoutedDecision;
	plan?: EvidencePlan | undefined;
	contract: TaskContract;
	state: HarnessState;
}): string {
	const { action, checkpoint, decision, plan, contract, state } = args;
	const lines: string[] = [];

	lines.push(`BLOCKED — ${verdictHeadline(decision.decision)}`);
	lines.push("");
	lines.push(`Action:      ${action.summary}`);
	lines.push(`Checkpoint:  ${checkpoint.checkpointType ?? "unspecified"} (${checkpoint.severity})`);
	lines.push(`Reason:      ${checkpoint.reason}`);

	const related = checkpoint.relatedRequirements
		.map((id) => `  ${id} — ${describeContractItem(contract, id)}`)
		.filter((line) => !line.includes("(unknown item"));
	if (related.length > 0) {
		lines.push("", "Relevant contract items:", ...related);
	}

	const evidenceLines = collectEvidenceLines(plan, state);
	if (evidenceLines.length > 0) {
		lines.push("", "Evidence collected:", ...evidenceLines);
	}

	if (decision.missingEvidence.length > 0) {
		lines.push("", "Missing:", ...decision.missingEvidence.map((m) => `  - ${m}`));
	}

	if (plan?.unverifiable.length) {
		lines.push(
			"",
			"Could not be verified:",
			...plan.unverifiable.map((u) => `  - ${u.requirementId}: ${u.reason}`),
		);
	}

	lines.push("");
	lines.push(`Judge:       ${decision.judgeId}${decision.degraded ? " (degraded — the primary Judge did not answer)" : ""}`);
	lines.push(`Decision:    ${decision.decision}`);
	lines.push(`Confidence:  ${decision.confidence.toFixed(2)}`);
	lines.push(`State:       v${decision.stateVersion}`);

	if (decision.reasons.length > 0) {
		lines.push("", "Judge reasoning:", ...decision.reasons.map((r) => `  - ${r}`));
	}

	if (decision.attempts.length > 0) {
		lines.push("", "Judges that could not answer:", ...decision.attempts.map((a) => `  - ${a.judgeId}: ${a.error}`));
	}

	lines.push("", nextSteps(decision));
	return lines.join("\n");
}

/** Structured feedback for a rejected completion (§44). Written for the worker model. */
export function renderCompletionRejection(args: {
	decision: RoutedDecision;
	plan?: EvidencePlan | undefined;
	contract: TaskContract;
	/** The gate's own deterministic evaluation, so settled conditions are reported as settled. */
	evaluation?: CompletionEvaluation | undefined;
}): string {
	const { decision, plan, contract, evaluation } = args;
	const lines: string[] = [];

	lines.push("COMPLETION REJECTED — the task is not finished.");
	lines.push("");
	lines.push("The harness evaluated your completion claim against the Task Contract and it did not pass.");
	lines.push("");

	if (decision.missingEvidence.length > 0) {
		lines.push("Missing:");
		for (const missing of decision.missingEvidence) lines.push(`  - ${missing}`);
		lines.push("");
	}

	const settled = new Set(evaluation?.conditions.filter((c) => c.status === "SATISFIED").map((c) => c.id) ?? []);
	if (settled.size > 0) {
		lines.push("Already verified (no action needed):");
		for (const condition of evaluation!.conditions) {
			if (condition.status === "SATISFIED") {
				lines.push(`  - ${condition.id}: ${condition.description}${condition.deterministic ? "" : "  [by the reviewer model, from the produced content]"}`);
			}
		}
		lines.push("");
	}

	const unsatisfied = contract.successConditions.filter((s) => !settled.has(s.id));
	if (unsatisfied.length > 0) {
		lines.push("Success conditions not yet verified:");
		for (const condition of unsatisfied) {
			lines.push(`  - ${condition.id}: ${condition.description}`);
			if (condition.verification?.length) {
				lines.push(`      typed verification: ${condition.verification.map((strategy) => strategy.kind).join(", ")}`);
			}
		}
		lines.push("");
	}

	if (plan?.unverifiable.length) {
		lines.push("Requirements with no available verification route:");
		for (const item of plan.unverifiable) lines.push(`  - ${item.requirementId}: ${item.reason}`);
		lines.push("");
	}

	if (decision.reasons.length > 0) {
		lines.push("Judge reasoning:");
		for (const reason of decision.reasons) lines.push(`  - ${reason}`);
		lines.push("");
	}

	lines.push(`Judge: ${decision.judgeId} · decision ${decision.decision} · confidence ${decision.confidence.toFixed(2)} · state v${decision.stateVersion}`);
	lines.push("");
	lines.push("How to continue — this matters, read it:");
	lines.push("  - The Judge sees what your tools actually returned (exit codes, output, listings, diffs).");
	lines.push("    Saying the work is done is not evidence. Demonstrating it with a tool result is.");
	lines.push("  - For each item above, run the command or inspection whose output shows it holds");
	lines.push("    (run the tests, list the files, show the diff, execute the check), then finish again.");
	lines.push("  - If an item is wrong, impossible, or needs a decision only the user can make, say so");
	lines.push("    explicitly and stop. The harness will hand the decision to the user; it will not");
	lines.push("    keep sending you back.");

	return lines.join("\n");
}

/**
 * The completion loop has been halted (§43 applied to §44).
 *
 * Written for the user as much as for the worker: the worker will not be restarted
 * by this message, so it must explain what happened and what the user can do.
 */
export function renderCompletionHalt(args: { reason: string; rejection: string }): string {
	return [
		"COMPLETION NOT VERIFIED — the harness has stopped the verify/retry loop.",
		"",
		`Why it stopped: ${args.reason}.`,
		"",
		"The task is paused and waits for you. Options:",
		"  - Reply with what you want done next (the worker continues under the same contract).",
		"  - Accept the result as-is when prompted, or run /harness abandon to drop the task.",
		"  - Run /harness evidence to see what was and was not verified.",
		"",
		"Last rejection:",
		...args.rejection.split("\n").map((line) => `  ${line}`),
	].join("\n");
}

/** The contract digest injected into the worker's context at task start. */
export function renderContractDigest(contract: TaskContract, stateVersion: number): string {
	const lines: string[] = [];

	lines.push("TASK CONTRACT (compiled and locked by the harness)");
	lines.push("");
	lines.push(`Goal: ${contract.goal}`);
	lines.push(`Contract v${contract.version} · state v${stateVersion} · task ${contract.id}`);

	const section = (title: string, items: ReadonlyArray<{ id: string; description: string; source?: string; priority?: string }>) => {
		if (items.length === 0) return;
		lines.push("", `${title}:`);
		for (const item of items) {
			const tags = [item.source, item.priority].filter(Boolean).join("/");
			lines.push(`  ${item.id}${tags ? ` [${tags}]` : ""} — ${item.description}`);
		}
	};

	section("Requirements", contract.requirements);
	section("Constraints", contract.constraints);
	section("Success conditions", contract.successConditions);
	section("Forbidden conditions", contract.forbiddenConditions);
	section("Critical actions (verified before they run)", contract.criticalActions);

	if (contract.ambiguities.length > 0) {
		lines.push("", "Ambiguities the compiler could not resolve:");
		for (const item of contract.ambiguities) {
			lines.push(`  ${item.id} — ${item.description}${item.defaultInterpretation ? ` (proceeding as: ${item.defaultInterpretation})` : ""}`);
		}
	}

	if (contract.assumptions.length > 0) {
		lines.push("", "Assumptions (NOT user instructions):");
		for (const item of contract.assumptions) lines.push(`  ${item.id} — ${item.description}`);
	}

	lines.push("");
	lines.push(
		"The harness enforces this contract at runtime. Critical actions are intercepted and verified before they run, " +
			"and completion is checked against the success conditions. You do not need to remember any of this — " +
			"work normally. If the harness blocks an action it will tell you exactly what evidence is missing.",
	);

	return lines.join("\n");
}

/** `/harness status` (§35). Never prints a secret — only a fingerprint. */
export function renderStatus(args: {
	enabled: boolean;
	compiler: string;
	reviewer: string;
	judgePrimary: string | undefined;
	judgeFallbacks: readonly string[];
	judgeEnabled: boolean;
	keySource: string;
	keyFingerprint: string;
	statePath: string;
	stateHealthy: boolean;
	task?: { id: string; goal: string; phase: string; contractVersion: number; stateVersion: number } | undefined;
	judgeStats?: { calls: number; failures: number; totalLatencyMs: number; estimatedCostUsd?: number } | undefined;
}): string {
	const lines: string[] = [];

	lines.push(`Harness:            ${args.enabled ? "enabled" : "disabled"}`);
	lines.push(`Task Compiler:      ${args.compiler}`);
	lines.push(`Contract Reviewer:  ${args.reviewer}`);
	lines.push("                    (change with /harness model)");
	lines.push(`State Store:        ${args.stateHealthy ? "healthy" : "UNWRITABLE"} (${displayPath(args.statePath)})`);
	lines.push(`Judge:              ${args.judgeEnabled ? (args.judgePrimary ?? "none configured") : "disabled"}`);
	if (args.judgeFallbacks.length > 0) {
		lines.push(`Judge fallbacks:    ${args.judgeFallbacks.join(" → ")}`);
	}
	lines.push(`OpenRouter Key:     ${args.keySource === "none" ? "not configured — run /login and choose OpenRouter" : `configured ${args.keySource} ${args.keyFingerprint}`}`);

	if (args.task) {
		lines.push("");
		lines.push(`Current Task:       ${args.task.phase}`);
		lines.push(`Goal:               ${clamp(args.task.goal, 120)}`);
		lines.push(`Task id:            ${args.task.id}`);
		lines.push(`Contract Version:   ${args.task.contractVersion}`);
		lines.push(`State Version:      ${args.task.stateVersion}`);
	} else {
		lines.push("");
		lines.push("Current Task:       none");
	}

	if (args.judgeStats && args.judgeStats.calls > 0) {
		const avg = Math.round(args.judgeStats.totalLatencyMs / args.judgeStats.calls);
		lines.push("");
		lines.push(`Judge calls:        ${args.judgeStats.calls} (${args.judgeStats.failures} failed, avg ${avg}ms)`);
		if (args.judgeStats.estimatedCostUsd !== undefined) {
			lines.push(`Estimated cost:     $${args.judgeStats.estimatedCostUsd.toFixed(5)}`);
		}
	}

	return lines.join("\n");
}

function collectEvidenceLines(plan: EvidencePlan | undefined, state: HarnessState): string[] {
	if (!plan) return [];
	const requestIds = new Set(plan.evidenceRequests.map((r) => r.id));

	return state.evidence
		.filter((e) => !e.supersededBy && requestIds.has(e.id.replace(/^evd-/, "evr-")))
		.slice(-10)
		.map((e) => `  - ${e.type} via ${e.source}: ${clamp(e.summary, 160)}`)
		.concat(
			plan.alreadySatisfied.length > 0
				? [`  - ${plan.alreadySatisfied.length} requirement(s) already had fresh evidence`]
				: [],
		);
}

function verdictHeadline(verdict: RoutedDecision["decision"]): string {
	switch (verdict) {
		case "FAIL":
			return "this action would violate the Task Contract";
		case "MORE_EVIDENCE":
			return "more evidence is required before this action can proceed";
		case "REVIEW":
			return "this action needs human review";
		case "PASS":
			return "allowed";
	}
}

function nextSteps(decision: RoutedDecision): string {
	switch (decision.decision) {
		case "FAIL":
			return "Do not retry this action as-is. Change the approach so it no longer conflicts with the contract, or ask the user to revise the task.";
		case "MORE_EVIDENCE":
			return "Gather the missing evidence listed above, then try the action again.";
		case "REVIEW":
			return "Ask the user to confirm before proceeding. Run `/harness decision` to see the full record.";
		case "PASS":
			return "Proceed.";
	}
}
