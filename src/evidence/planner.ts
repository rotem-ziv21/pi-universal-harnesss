import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { TaskContract, VerificationStrategy } from "../contract/schema.ts";
import { assessFreshness, changedTargetsSince, evidenceFor } from "../state/freshness.ts";
import type { FreshnessClass, HarnessState } from "../state/types.ts";
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
						}).fresh,
				);
				if (existing.length > 0) {
					alreadySatisfied.push(target.id);
					continue;
				}
				if (target.verification.length === 0) {
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
	const add = (item: { id: string; description: string; priority: "hard" | "soft"; verification?: readonly VerificationStrategy[] }) =>
		targets.set(item.id, {
			id: item.id,
			description: item.description,
			priority: item.priority,
			verification: item.verification ?? [],
		});

	if (checkpoint.checkpointType === "completion_claim") {
		for (const item of contract.requirements) if (item.priority === "hard") add(item);
		for (const item of contract.successConditions) add(item);
		for (const item of contract.constraints) if (item.priority === "hard") add(item);
		for (const item of contract.forbiddenConditions) if (item.priority === "hard") add(item);
		return [...targets.values()];
	}

	for (const item of contract.requirements) if (wanted.has(item.id)) add(item);
	for (const item of contract.successConditions) if (wanted.has(item.id)) add(item);
	for (const item of contract.constraints) if (wanted.has(item.id)) add(item);
	for (const item of contract.forbiddenConditions) if (wanted.has(item.id)) add(item);
	if (targets.size === 0) {
		for (const item of contract.constraints) if (item.priority === "hard") add(item);
		for (const item of contract.requirements) if (item.priority === "hard") add(item);
	}
	return [...targets.values()];
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
