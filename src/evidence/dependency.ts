import { basename } from "node:path";
import type { ProposedAction } from "../checkpoints/types.ts";
import { describeContractItem, type TaskContract } from "../contract/schema.ts";
import type { EvidencePlan } from "./types.ts";

export interface GateDependencyAnalysis {
	readonly dependsOnBlockedAction: boolean;
	readonly requirementIds: readonly string[];
	readonly reason: string;
}

/**
 * Prevent an evidence cycle: construction needed to create evidence cannot itself
 * require the evidence, provided the action is reversible, local and task-owned.
 */
export function analyzeGateDependency(
	plan: EvidencePlan,
	action: ProposedAction,
	contract: TaskContract,
): GateDependencyAnalysis {
	const semantics = action.actionSemantics;
	if (
		semantics.reversibility !== "high" ||
		semantics.externalSideEffect ||
		semantics.targetOwnership === "outside_scope"
	) {
		return {
			dependsOnBlockedAction: false,
			requirementIds: [],
			reason: "The action is not reversible task-local construction, so dependency bypass is unavailable.",
		};
	}

	const dependent: string[] = [];
	const target = semantics.target ? basename(semantics.target).toLowerCase() : "";
	for (const requirementId of plan.requirementsToVerify) {
		const description = describeContractItem(contract, requirementId).toLowerCase();
		const testCreation = semantics.capabilities.includes("write_file") && /(^|[/_.-])tests?([/_.-]|$)/i.test(target) && /\btests?\b/.test(description);
		const documentationCreation = semantics.capabilities.includes("write_file") && /^readme(?:\.|$)/i.test(target) && /\b(readme|documentation|usage)\b/.test(description);
		const executionEvidence = semantics.capabilities.includes("run_tests") && /\b(test|pass|verify)\w*/.test(description);
		const namedArtifact = target.length > 0 && description.includes(target);
		if (testCreation || documentationCreation || executionEvidence || namedArtifact) dependent.push(requirementId);
	}

	return dependent.length > 0
		? {
				dependsOnBlockedAction: true,
				requirementIds: dependent,
				reason: `The proposed action is needed to produce evidence for ${dependent.join(", ")}; BUILD policy permits it.`,
			}
		: {
				dependsOnBlockedAction: false,
				requirementIds: [],
				reason: "No planned evidence is causally dependent on this action.",
			};
}
