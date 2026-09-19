import { matchesActionSelector } from "../checkpoints/signals.ts";
import type { ProposedAction } from "../checkpoints/types.ts";
import type { TaskContract, VerificationStrategy } from "../contract/schema.ts";
import { resourceUri } from "../resources/registry.ts";
import type { EvidencePlan } from "./types.ts";

export interface GateDependencyAnalysis {
	readonly dependsOnBlockedAction: boolean;
	readonly requirementIds: readonly string[];
	readonly reason: string;
}

/** Prevent a typed evidence cycle for reversible, allowed-scope construction. */
export function analyzeGateDependency(
	plan: EvidencePlan,
	action: ProposedAction,
	contract: TaskContract,
): GateDependencyAnalysis {
	const semantics = action.actionSemantics;
	if (
		semantics.reversibility !== "high" ||
		semantics.externalSideEffect ||
		semantics.effects.some((effect) => effect.scope === "protected" || effect.scope === "outside_allowed")
	) {
		return {
			dependsOnBlockedAction: false,
			requirementIds: [],
			reason: "The action is not reversible allowed-scope construction, so dependency bypass is unavailable.",
		};
	}
	const cwd = contract.metadata.cwd ?? process.cwd();
	const dependent = new Set<string>();
	for (const request of plan.evidenceRequests) {
		if (strategyDependsOnAction(request.strategy, action, cwd)) {
			for (const id of request.requirementIds) dependent.add(id);
		}
	}
	return dependent.size > 0
		? {
				dependsOnBlockedAction: true,
				requirementIds: [...dependent],
				reason: `The proposed action creates resources or events required by typed verification for ${[...dependent].join(", ")}.`,
			}
		: {
				dependsOnBlockedAction: false,
				requirementIds: [],
				reason: "No typed verification strategy depends on this action.",
			};
}

function strategyDependsOnAction(strategy: VerificationStrategy, action: ProposedAction, cwd: string): boolean {
	if (strategy.kind === "event_log_assertion") return matchesActionSelector(strategy.action, action);
	let resources: readonly string[] = [];
	if (strategy.kind === "resource_state") resources = [strategy.resource];
	if (strategy.kind === "visual_evaluation") resources = strategy.resources;
	if (strategy.kind === "semantic_evaluation") resources = strategy.evidenceSources;
	if (resources.length === 0) return false;
	const expectedUris = new Set(resources.map((resource) => resourceUri(resource, cwd)));
	return action.actionSemantics.effects.some(
		(effect) => expectedUris.has(effect.uri) && effect.operation !== "read" && effect.operation !== "query",
	);
}
