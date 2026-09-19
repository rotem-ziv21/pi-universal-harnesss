import { existsSync, readFileSync } from "node:fs";
import type { TaskContract } from "../contract/schema.ts";
import type { ActionCapability } from "../checkpoints/types.ts";
import { assessFreshness, changedTargetsSince, evidenceFor } from "../state/freshness.ts";
import type {
	CompletionConditionResult,
	CompletionEvaluation,
	EvidenceRef,
	HarnessState,
	RecordedAction,
} from "../state/types.ts";
import { nowIso } from "../util/ids.ts";

const FILE_MUTATION_CAPABILITIES: Partial<Record<ActionCapability, true>> = {
	write_file: true,
	delete_file: true,
	move_file: true,
	create_directory: true,
};

export function evaluateCompletionConditions(args: {
	contract: TaskContract;
	state: HarnessState;
	cwd: string;
}): CompletionEvaluation {
	const conditions: CompletionConditionResult[] = [];
	for (const requirement of args.contract.requirements) {
		conditions.push(evaluatePositive(requirement, "requirement", args.state));
	}
	for (const success of args.contract.successConditions) {
		conditions.push(evaluatePositive(success, "success", args.state));
	}
	for (const constraint of args.contract.constraints) {
		conditions.push(evaluateInvariant(constraint, "constraint", args.state));
	}
	for (const forbidden of args.contract.forbiddenConditions) {
		conditions.push(evaluateInvariant(forbidden, "forbidden", args.state));
	}

	return {
		stateVersion: args.state.stateVersion,
		evaluatedAt: nowIso(),
		conditions,
	};
}

function evaluatePositive(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: "requirement" | "success",
	state: HarnessState,
): CompletionConditionResult {
	const evidence = freshEvidence(state, item.id);
	const contradicted = evidence.find((entry) => entry.result === "contradicted" && isDeterministicEvidence(entry));
	if (contradicted) {
		return condition(item, kind, "UNSATISFIED", contradicted.summary, [contradicted.id], true);
	}

	const supported = evidence.filter((entry) => entry.result === "supported" && isDeterministicEvidence(entry));
	if (supported.length > 0) {
		return condition(
			item,
			kind,
			"SATISFIED",
			`Deterministic runtime evidence: ${supported.map((entry) => entry.summary).join("; ")}`,
			supported.map((entry) => entry.id),
			true,
		);
	}

	if (/\btests?\b.*\b(pass|passing|succeed|successful)|\b(pass|passing)\w*\b.*\btests?\b/i.test(item.description)) {
		const testRun = latestSucceeded(state.actions, (action) => action.actionSemantics?.capabilities.includes("run_tests") ?? false);
		if (testRun) {
			return condition(item, kind, "SATISFIED", `Test command succeeded: ${testRun.summary}`, [], true);
		}
	}

	if (/\breadme\b/i.test(item.description)) {
		const readme = [...state.actions]
			.reverse()
			.find(
				(action) =>
					action.outcome === "succeeded" &&
					(action.actionSemantics?.capabilities.includes("write_file") ?? false) &&
					/[/\\]readme(?:\.[^/\\]+)?$/i.test(action.actionSemantics?.target ?? ""),
			);
		const path = readme?.actionSemantics?.target;
		if (path && existsSync(path)) {
			const needsUsage = /\b(usage|instructions?|invoke|run|example)\b/i.test(item.description);
			const content = readFileSync(path, "utf8");
			const hasUsage = /\busage\b|\bpython(?:3)?\s+\S+\.py\b|--help|```(?:sh|bash|console)?/i.test(content);
			if (!needsUsage || hasUsage) {
				return condition(
					item,
					kind,
					"SATISFIED",
					`${path} exists${needsUsage ? " and contains usage instructions" : ""}.`,
					[],
					true,
				);
			}
			return condition(item, kind, "UNSATISFIED", `${path} exists but no usage instructions were detected.`, [], true);
		}
	}

	return condition(
		item,
		kind,
		"UNKNOWN",
		evidence.length > 0
			? "Only semantic or inconclusive evidence is available; a Judge must assess it."
			: "No current requirement-specific evidence is available.",
		evidence.map((entry) => entry.id),
		false,
	);
}

function evaluateInvariant(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: "constraint" | "forbidden",
	state: HarnessState,
): CompletionConditionResult {
	const text = item.description.toLowerCase();
	const succeeded = state.actions.filter((action) => action.outcome === "succeeded");

	if (/\b(commit|push|remote)\w*/.test(text)) {
		const violations = succeeded.filter(
			(action) =>
				(action.actionSemantics?.capabilities.includes("commit_git") ?? false) ||
				(action.actionSemantics?.capabilities.includes("mutate_remote") ?? false),
		);
		return invariantFromCount(item, kind, violations, "git commit/push", state);
	}
	if (/\b(delete|deletion|remove|removal)\w*/.test(text) && /\b(existing|pre-existing|preexisting)\b/.test(text)) {
		const violations = succeeded.filter(
			(action) =>
				(action.actionSemantics?.capabilities.includes("delete_file") ?? false) &&
				action.actionSemantics?.targetOwnership === "preexisting",
		);
		return invariantFromCount(item, kind, violations, "deletion of pre-existing files", state);
	}
	if (/\b(outside|within|only inside|only in)\b/.test(text) && /\b(path|folder|directory|file)\w*/.test(text)) {
		const violations = succeeded.filter(
			(action) =>
				action.actionSemantics?.targetOwnership === "outside_scope" &&
				action.actionSemantics.capabilities.some((capability) => capability in FILE_MUTATION_CAPABILITIES),
		);
		return invariantFromCount(item, kind, violations, "writes outside task scope", state);
	}
	if (/\b(deploy|deployment|production|release)\w*/.test(text)) {
		const violations = succeeded.filter((action) => action.actionSemantics?.capabilities.includes("deploy") ?? false);
		return invariantFromCount(item, kind, violations, "deployments", state);
	}
	if (/\b(database|db|sql|migration)\w*/.test(text)) {
		const violations = succeeded.filter((action) => action.actionSemantics?.capabilities.includes("mutate_database") ?? false);
		return invariantFromCount(item, kind, violations, "database mutations", state);
	}
	if (/\b(dependenc|package|library|libraries)\w*/.test(text)) {
		const changes = succeeded.filter((action) => action.actionSemantics?.capabilities.includes("change_dependencies") ?? false);
		if (changes.length === 0) return invariantFromCount(item, kind, [], "dependency changes", state);
		return condition(
			item,
			kind,
			"UNKNOWN",
			`${changes.length} dependency change(s) occurred; necessity is a semantic question.`,
			[],
			false,
		);
	}

	const evidence = freshEvidence(state, item.id);
	const supported = evidence.find((entry) => entry.result === "supported" && isDeterministicEvidence(entry));
	if (supported) return condition(item, kind, "SATISFIED", supported.summary, [supported.id], true);
	const contradicted = evidence.find((entry) => entry.result === "contradicted" && isDeterministicEvidence(entry));
	if (contradicted) return condition(item, kind, "UNSATISFIED", contradicted.summary, [contradicted.id], true);
	return condition(item, kind, "UNKNOWN", "This invariant is not directly observable from current events.", [], false);
}

function invariantFromCount(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: "constraint" | "forbidden",
	violations: RecordedAction[],
	label: string,
	state: HarnessState,
): CompletionConditionResult {
	const satisfied = violations.length === 0;
	return condition(
		item,
		kind,
		satisfied ? "SATISFIED" : "UNSATISFIED",
		`Harness event log: ${violations.length} successful ${label} since task start (${state.actions.length} observed tool calls).`,
		[],
		true,
	);
}

function condition(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: CompletionConditionResult["kind"],
	status: CompletionConditionResult["status"],
	reason: string,
	evidenceIds: string[],
	deterministic: boolean,
): CompletionConditionResult {
	return { id: item.id, description: item.description, priority: item.priority, kind, status, reason, evidenceIds, deterministic };
}

function freshEvidence(state: HarnessState, requirementId: string): EvidenceRef[] {
	const now = Date.now();
	return evidenceFor(state.evidence, requirementId).filter((entry) =>
		assessFreshness(entry, {
			now,
			currentStateVersion: state.stateVersion,
			changedTargets: changedTargetsSince(state.actions, entry.stateVersion),
		}).fresh,
	);
}

function isDeterministicEvidence(evidence: EvidenceRef): boolean {
	return (
		evidence.trust === "runtime_evidence" &&
		["command_result", "file_state", "exact_output", "runtime_invariant"].includes(evidence.type)
	);
}

function latestSucceeded(actions: readonly RecordedAction[], predicate: (action: RecordedAction) => boolean): RecordedAction | undefined {
	return [...actions].reverse().find((action) => action.outcome === "succeeded" && predicate(action));
}
