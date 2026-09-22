import type { ActionSelector, Constraint, ForbiddenCondition, TaskContract } from "../contract/schema.ts";
import { resourcePath } from "../resources/registry.ts";
import type { ResourceEffect } from "../resources/types.ts";
import type { CheckpointSignal, ProposedAction } from "./types.ts";

export interface ConstraintActionMatch {
	readonly relevant: boolean;
	readonly violates: boolean;
	readonly reason: string;
}

export function contractCriticalActionSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	for (const critical of contract.criticalActions) {
		const matched = critical.action ? matchesActionSelector(critical.action, action) : genericCriticalCandidate(action);
		if (!matched) continue;
		signals.push({
			type: "contract_critical_action",
			reason: critical.action
				? `The action matches the contract's structured critical-action selector: "${critical.description}"`
				: `A low-reversibility action requires semantic review against: "${critical.description}"`,
			origin: "contract",
			weight: critical.action ? 1 : 0.6,
			relatedItemIds: [critical.id, ...critical.requiresVerificationOf],
		});
	}
	return signals;
}

export function constraintRiskSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	for (const constraint of contract.constraints) {
		if (constraint.priority !== "hard" || !constraint.policy) continue;
		const match = matchConstraintToAction(constraint, action);
		if (!match.relevant) continue;
		signals.push({
			type: "constraint_risk",
			reason: match.reason,
			origin: "contract",
			weight: match.violates ? 1 : 0.8,
			relatedItemIds: [constraint.id],
		});
	}
	for (const forbidden of contract.forbiddenConditions) {
		if (forbidden.priority !== "hard" || !forbidden.policy) continue;
		const match = matchForbiddenToAction(forbidden, action);
		if (!match.relevant) continue;
		signals.push({
			type: "constraint_risk",
			reason: match.reason,
			origin: "contract",
			weight: 1,
			relatedItemIds: [forbidden.id],
		});
	}
	return signals;
}

export function matchConstraintToAction(constraint: Constraint, action: ProposedAction): ConstraintActionMatch {
	if (!constraint.policy || !matchesActionSelector(constraint.policy.action, action)) {
		return { relevant: false, violates: false, reason: "The structured policy selector does not match this action." };
	}
	const violates = constraint.policy.effect === "forbid";
	return {
		relevant: true,
		violates,
		reason: violates
			? `The action matches a forbidden capability/provenance/scope policy: "${constraint.description}"`
			: `The action requires review under structured policy: "${constraint.description}"`,
	};
}

export function matchesActionSelector(selector: ActionSelector, action: ProposedAction): boolean {
	const semantics = action.actionSemantics;
	if (selector.capabilities?.length && !selector.capabilities.every((capability) => semantics.capabilities.includes(capability))) {
		return false;
	}
	if (selector.externalSideEffect !== undefined && selector.externalSideEffect !== semantics.externalSideEffect) return false;
	const hasEffectFilter = Boolean(
		selector.operations?.length ||
			selector.resourceKinds?.length ||
			selector.provenances?.length ||
			selector.scopes?.length ||
			selector.targetUriPrefix,
	);
	if (!hasEffectFilter) return true;
	return semantics.effects.some((effect) => effectMatches(selector, effect));
}

export function externalMutationSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (!action.actionSemantics.externalSideEffect) return undefined;
	return {
		type: "external_mutation",
		reason: "This action changes state outside the local task workspace.",
		origin: "generic",
		weight: 0.85,
		relatedItemIds: [],
	};
}

export function destructiveSignal(action: ProposedAction): CheckpointSignal | undefined {
	const deletions = action.actionSemantics.effects.filter((effect) => effect.operation === "delete");
	if (deletions.length === 0) return undefined;
	if (deletions.every((effect) => effect.provenance === "created_by_current_task" && effect.scope === "allowed")) return undefined;
	const protectedDeletion = deletions.some((effect) => effect.scope === "protected" || effect.scope === "outside_allowed");
	const preexistingDeletion = deletions.some((effect) => effect.provenance === "preexisting");
	return {
		type: "destructive",
		reason: protectedDeletion
			? "This action deletes a protected or out-of-scope resource."
			: preexistingDeletion
				? "This action deletes a pre-existing resource."
				: "This action deletes a resource whose provenance is unknown.",
		origin: "generic",
		weight: 0.85,
		relatedItemIds: [],
	};
}

export function irreversibleSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (action.actionSemantics.reversibility !== "low") return undefined;
	if (action.actionSemantics.capabilities.includes("delete_resource") || action.actionSemantics.externalSideEffect) return undefined;
	return {
		type: "irreversible",
		reason: "This action has a low-reversibility side effect.",
		origin: "generic",
		weight: 0.8,
		relatedItemIds: [],
	};
}

export function scopeViolationSignals(action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	for (const effect of action.actionSemantics.effects) {
		if (["read", "query", "execute"].includes(effect.operation)) continue;
		if (effect.scope !== "protected" && effect.scope !== "outside_allowed") continue;
		signals.push({
			type: "constraint_risk",
			reason:
				effect.scope === "protected"
					? `This action mutates protected resource ${effect.uri}.`
					: `This action mutates resource ${effect.uri} outside the allowed workspace scopes.`,
			origin: "contract",
			weight: 1,
			relatedItemIds: [],
		});
	}
	return signals;
}

export function unknownClassificationSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (action.actionSemantics.classification !== "unknown") return undefined;
	return {
		type: "constraint_risk",
		reason: "No semantic adapter declared whether this tool mutates resources, so it requires review.",
		origin: "generic",
		weight: 0.8,
		relatedItemIds: [],
	};
}

export function protectedPathSignals(protectedPaths: readonly string[], action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	for (const effect of action.actionSemantics.effects) {
		if (!["create", "modify", "delete", "move"].includes(effect.operation)) continue;
		const path = resourcePath(effect.uri) ?? effect.uri;
		for (const protectedPath of protectedPaths) {
			if (!pathsOverlap(path, protectedPath)) continue;
			signals.push({
				type: "constraint_risk",
				reason: `This action touches "${protectedPath}", which project configuration marks as protected.`,
				origin: "project",
				weight: 1,
				relatedItemIds: [],
			});
		}
	}
	return signals;
}

export function isMutating(action: ProposedAction): boolean {
	if (action.actionSemantics.classification === "unknown") return true;
	return action.actionSemantics.effects.some((effect) => !["read", "query", "execute"].includes(effect.operation)) || action.actionSemantics.externalSideEffect;
}

export function extractPathLikeTokens(action: ProposedAction): string[] {
	return action.actionSemantics.effects.map((effect) => resourcePath(effect.uri) ?? effect.uri);
}

export function pathsOverlap(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (!na || !nb) return false;
	return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function matchForbiddenToAction(forbidden: ForbiddenCondition, action: ProposedAction): ConstraintActionMatch {
	if (!forbidden.policy || !matchesActionSelector(forbidden.policy.action, action)) {
		return { relevant: false, violates: false, reason: "The structured forbidden-condition selector does not match." };
	}
	return {
		relevant: true,
		violates: true,
		reason: `The action directly reaches a typed forbidden condition: "${forbidden.description}"`,
	};
}

function effectMatches(selector: ActionSelector, effect: ResourceEffect): boolean {
	if (selector.operations?.length && !selector.operations.includes(effect.operation)) return false;
	if (selector.resourceKinds?.length && !selector.resourceKinds.includes(effect.kind)) return false;
	if (selector.provenances?.length && !selector.provenances.includes(effect.provenance)) return false;
	if (selector.scopes?.length && !selector.scopes.includes(effect.scope)) return false;
	if (selector.targetUriPrefix && !effect.uri.startsWith(selector.targetUriPrefix)) return false;
	if (selector.excludeTargets?.some((excluded) => targetExcluded(effect.uri, excluded))) return false;
	return true;
}

/** An exclusion matches by URI prefix, or by path suffix so a workspace-relative name works. */
function targetExcluded(uri: string, excluded: string): boolean {
	const candidate = excluded.trim();
	if (!candidate) return false;
	if (uri.startsWith(candidate)) return true;
	const path = resourcePath(uri) ?? uri;
	const rel = normalizePath(candidate);
	if (!rel) return false;
	const norm = normalizePath(path);
	return norm === rel || norm.endsWith(`/${rel}`) || norm.startsWith(`${rel}/`) || norm.includes(`/${rel}/`);
}

function genericCriticalCandidate(action: ProposedAction): boolean {
	return action.actionSemantics.externalSideEffect || action.actionSemantics.reversibility === "low";
}

function normalizePath(path: string): string {
	return path
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/\\/g, "/")
		.replace(/\/?\*+.*$/, "")
		.replace(/^\.\//, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}
