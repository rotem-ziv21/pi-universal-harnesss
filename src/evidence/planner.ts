import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { TaskContract, VerificationStrategy } from "../contract/schema.ts";
import { assessFreshness, changedTargetsSince, evidenceFor, worldVersion } from "../state/freshness.ts";
import type { FreshnessClass, HarnessState } from "../state/types.ts";
import { resourcePath } from "../resources/registry.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { EvidencePlan, EvidenceRequest } from "./types.ts";

export interface EvidencePlanner {
	plan(args: {
		contract: TaskContract;
		state: HarnessState;
		checkpoint: CheckpointDecision;
		checkpointId: string;
		action: ProposedAction;
		projectConfig?: ProjectConfig | undefined;
	}): EvidencePlan;
}

interface PlanTarget {
	readonly id: string;
	readonly description: string;
	readonly priority: "hard" | "soft";
	readonly kind: "requirement" | "success" | "constraint" | "forbidden";
	readonly verification: readonly VerificationStrategy[];
}

export function createEvidencePlanner(options: { logger?: Logger } = {}): EvidencePlanner {
	const log = (options.logger ?? nullLogger).child("evidence:plan");
	return {
		plan({ contract, state, checkpoint, checkpointId }): EvidencePlan {
			const targets = resolveTargets(contract, checkpoint);
			const requests: EvidenceRequest[] = [];
			const alreadySatisfied: string[] = [];
			const unverifiable: Array<{ requirementId: string; reason: string }> = [];
			const now = Date.now();

			for (const target of targets) {
				const existing = evidenceFor(state.evidence, target.id).filter(
					(item) =>
						item.result === "supported" &&
						item.trust === "runtime_evidence" &&
						assessFreshness(item, {
							now,
							currentStateVersion: state.stateVersion,
							changedTargets: changedTargetsSince(state.actions, item.stateVersion),
				worldVersion: worldVersion(state.actions),
						}).fresh,
				);
				if (existing.length > 0) {
					alreadySatisfied.push(target.id);
					continue;
				}
				if (target.verification.length === 0) {
					/**
					 * At a completion claim, a hard condition with no typed check is not
					 * abandoned to guesswork. The harness synthesizes a semantic evaluation:
					 * the reviewer model reads what the task produced (files it created or
					 * modified) and the recent tool results, and says whether the condition
					 * holds. That is model interpretation and is recorded as such — it never
					 * becomes a deterministic fact — but it gives the Judge a real, sourced
					 * evidence item instead of a 300-character snippet to reason from.
					 */
					if (checkpoint.checkpointType === "completion_claim" && target.priority === "hard") {
						requests.push(
							requestFor(target, {
								kind: "semantic_evaluation",
								instructions: reviewerInstructions(target),
								evidenceSources: producedResources(state),
							}),
						);
						continue;
					}
					unverifiable.push({
						requirementId: target.id,
						reason: "The contract defines no typed verification strategy; descriptive prose is never executed.",
					});
					continue;
				}
				for (const strategy of target.verification) requests.push(requestFor(target, strategy));
			}

			const costRank = { cheap: 0, moderate: 1, expensive: 2 } as const;
			requests.sort((a, b) => {
				if (a.necessity !== b.necessity) return a.necessity === "required" ? -1 : 1;
				return costRank[a.cost] - costRank[b.cost];
			});
			const plan: EvidencePlan = {
				checkpointId,
				requirementsToVerify: targets.map((target) => target.id),
				evidenceRequests: requests,
				alreadySatisfied,
				unverifiable,
				preferredEvaluators: checkpoint.severity === "critical" ? ["primary", "fallback"] : ["primary"],
			};
			log.info("evidence planned", {
				checkpointId,
				targets: targets.length,
				requests: requests.length,
				satisfied: alreadySatisfied.length,
				unverifiable: unverifiable.length,
			});
			return plan;
		},
	};
}

function resolveTargets(contract: TaskContract, checkpoint: CheckpointDecision): PlanTarget[] {
	const wanted = new Set(checkpoint.relatedRequirements);
	const targets = new Map<string, PlanTarget>();
	const add = (
		kind: PlanTarget["kind"],
		item: { id: string; description: string; priority: "hard" | "soft"; verification?: readonly VerificationStrategy[] },
	) =>
		targets.set(item.id, {
			id: item.id,
			description: item.description,
			priority: item.priority,
			kind,
			verification: item.verification ?? [],
		});

	if (checkpoint.checkpointType === "completion_claim") {
		for (const item of contract.requirements) if (item.priority === "hard") add("requirement", item);
		for (const item of contract.successConditions) add("success", item);
		for (const item of contract.constraints) if (item.priority === "hard") add("constraint", item);
		for (const item of contract.forbiddenConditions) if (item.priority === "hard") add("forbidden", item);
		return [...targets.values()];
	}

	for (const item of contract.requirements) if (wanted.has(item.id)) add("requirement", item);
	for (const item of contract.successConditions) if (wanted.has(item.id)) add("success", item);
	for (const item of contract.constraints) if (wanted.has(item.id)) add("constraint", item);
	for (const item of contract.forbiddenConditions) if (wanted.has(item.id)) add("forbidden", item);
	// No fallback to "every hard item": an action gate verifies what it is linked to,
	// nothing more. Unrelated requirements are the completion gate's business.
	return [...targets.values()];
}

/** Files the task itself created or modified and that still exist, newest first. */
/**
 * A forbidden condition describes the outcome that must NOT have happened ("any
 * file other than report.md is created"). Asked "does this hold?", a reviewer that
 * finds only report.md answers NOT_VERIFIED — the event did not occur — and the
 * harness read that as the prohibition being broken. Same facts, opposite labels
 * on consecutive runs. The question is therefore put in terms of the prohibition
 * being respected, so VERIFIED always means "the task is fine on this point".
 */
function reviewerInstructions(target: PlanTarget): string {
	if (target.kind === "forbidden") {
		return (
			`This is a FORBIDDEN outcome of the task — it must not have happened: "${target.description}". ` +
			"Judging only from the supplied sources and tool results, determine whether it occurred. " +
			"Answer VERIFIED if the material shows it did NOT occur (the prohibition was respected); " +
			"NOT_VERIFIED if the material shows it DID occur; CANNOT_DETERMINE if the material does not settle it."
		);
	}
	return (
		`Determine whether this condition of the task holds, judging only from the supplied sources and tool results: "${target.description}". ` +
		"Answer VERIFIED only if the supplied material shows it; NOT_VERIFIED if it shows the opposite; CANNOT_DETERMINE if the material does not settle it."
	);
}

function producedResources(state: HarnessState): string[] {
	return [...state.workspace.resources]
		.filter((r) => r.status === "active" && r.kind === "file" && r.provenance === "created_by_current_task")
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
		.slice(0, 6)
		.map((r) => resourcePath(r.uri) ?? r.uri);
}

function requestFor(target: PlanTarget, strategy: VerificationStrategy): EvidenceRequest {
	return {
		id: newId("evr"),
		requirementIds: [target.id],
		description: `Verify "${target.description}" using ${strategy.kind}`,
		strategy,
		necessity: target.priority === "hard" ? "required" : "optional",
		cost: strategyCost(strategy),
		freshnessClass: strategyFreshness(strategy),
	};
}

function strategyCost(strategy: VerificationStrategy): EvidenceRequest["cost"] {
	if (strategy.kind === "resource_state" || strategy.kind === "event_log_assertion") return "cheap";
	if (strategy.kind === "command_execution") return "moderate";
	return "expensive";
}

function strategyFreshness(strategy: VerificationStrategy): FreshnessClass {
	if (strategy.kind === "resource_state") return "until_change";
	if (strategy.kind === "event_log_assertion") return "persistent";
	return "temporary";
}
