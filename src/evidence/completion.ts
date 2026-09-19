import type { ActionSelector, TaskContract } from "../contract/schema.ts";
import { matchesActionSelector } from "../checkpoints/signals.ts";
import { assessFreshness, changedTargetsSince, evidenceFor } from "../state/freshness.ts";
import type {
	CompletionConditionResult,
	CompletionEvaluation,
	EvidenceRef,
	HarnessState,
	RecordedAction,
} from "../state/types.ts";
import { nowIso } from "../util/ids.ts";

export function evaluateCompletionConditions(args: {
	contract: TaskContract;
	state: HarnessState;
}): CompletionEvaluation {
	const conditions: CompletionConditionResult[] = [];
	for (const requirement of args.contract.requirements) {
		conditions.push(evaluateEvidenceCondition(requirement, "requirement", args.state));
	}
	for (const success of args.contract.successConditions) {
		conditions.push(evaluateEvidenceCondition(success, "success", args.state));
	}
	for (const constraint of args.contract.constraints) {
		if (constraint.policy) {
			conditions.push(
				evaluatePolicyCondition(constraint, "constraint", constraint.policy.effect, constraint.policy.action, args.state),
			);
		} else {
			conditions.push(evaluateEvidenceCondition(constraint, "constraint", args.state));
		}
	}
	for (const forbidden of args.contract.forbiddenConditions) {
		if (forbidden.policy) {
			conditions.push(evaluatePolicyCondition(forbidden, "forbidden", "forbid", forbidden.policy.action, args.state));
		} else {
			conditions.push(evaluateEvidenceCondition(forbidden, "forbidden", args.state));
		}
	}
	return { stateVersion: args.state.stateVersion, evaluatedAt: nowIso(), conditions };
}

function evaluateEvidenceCondition(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: CompletionConditionResult["kind"],
	state: HarnessState,
): CompletionConditionResult {
	const evidence = freshEvidence(state, item.id);
	const contradicted = evidence.find((entry) => entry.result === "contradicted" && isConclusiveEvidence(entry));
	if (contradicted) {
		return condition(item, kind, "UNSATISFIED", contradicted.summary, [contradicted.id], true);
	}
	const supported = evidence.filter((entry) => entry.result === "supported" && isConclusiveEvidence(entry));
	if (supported.length > 0) {
		return condition(
			item,
			kind,
			"SATISFIED",
			`Linked evidence: ${supported.map((entry) => entry.summary).join("; ")}`,
			supported.map((entry) => entry.id),
			true,
		);
	}
	return condition(
		item,
		kind,
		"UNKNOWN",
		evidence.length > 0
			? "Only inconclusive or model-interpreted evidence is linked to this condition."
			: "No fresh evidence is explicitly linked to this condition.",
		evidence.map((entry) => entry.id),
		false,
	);
}

function evaluatePolicyCondition(
	item: { id: string; description: string; priority: "hard" | "soft" },
	kind: "constraint" | "forbidden",
	effect: "forbid" | "require_review",
	selector: ActionSelector,
	state: HarnessState,
): CompletionConditionResult {
	const matching = state.actions.filter(
		(action) => action.outcome === "succeeded" && matchesActionSelector(selector, asProposedAction(action)),
	);
	if (effect === "forbid") {
		return condition(
			item,
			kind,
			matching.length === 0 ? "SATISFIED" : "UNSATISFIED",
			`Canonical event log contains ${matching.length} successful action(s) matching the forbidden selector.`,
			[],
			true,
		);
	}
	const unreviewed = matching.filter(
		(action) =>
			!state.checkpoints.some(
				(checkpoint) => checkpoint.actionId === action.id && (checkpoint.outcome === "allowed" || checkpoint.outcome === "user_approved"),
			),
	);
	return condition(
		item,
		kind,
		unreviewed.length === 0 ? "SATISFIED" : "UNSATISFIED",
		unreviewed.length === 0
			? `All ${matching.length} matching successful action(s) passed a recorded review checkpoint.`
			: `${unreviewed.length} matching successful action(s) have no recorded review checkpoint.`,
		[],
		true,
	);
}

function asProposedAction(action: RecordedAction) {
	return { ...action, input: {} };
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

function isConclusiveEvidence(evidence: EvidenceRef): boolean {
	if (evidence.trust === "user_instruction" && evidence.type === "user_confirmation") return true;
	return (
		evidence.trust === "runtime_evidence" &&
		["command_execution", "resource_state", "event_log_assertion"].includes(evidence.type)
	);
}
