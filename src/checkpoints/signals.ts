import { semanticActionText } from "./action-semantics.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { ActionCapability, CheckpointSignal, ProposedAction } from "./types.ts";

/**
 * Capability-aware checkpoint signals. Only active tool semantics are considered:
 * source text, patches, request bodies and other payload data are never searched.
 */

export interface ConstraintActionMatch {
	readonly relevant: boolean;
	readonly violates: boolean;
	readonly reason: string;
	readonly capabilities: readonly ActionCapability[];
}

export function contractCriticalActionSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const haystack = actionText(action);
	const signals: CheckpointSignal[] = [];

	for (const critical of contract.criticalActions) {
		const matched = relevantCapabilities(critical.description).filter((capability) =>
			action.actionSemantics.capabilities.includes(capability),
		);
		const score = overlapScore(critical.description, haystack);
		if (matched.length === 0 && score < 0.34) continue;

		signals.push({
			type: "contract_critical_action",
			reason:
				matched.length > 0
					? `This action has ${matched.join(", ")}, matching critical action: "${critical.description}"`
					: `This action matches the contract's critical action: "${critical.description}"`,
			origin: "contract",
			weight: 1,
			relatedItemIds: [critical.id, ...critical.requiresVerificationOf],
		});
	}
	return signals;
}

export function constraintRiskSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	const target = action.actionSemantics.target;

	for (const constraint of contract.constraints) {
		if (constraint.priority !== "hard") continue;

		if (constraint.check && target && pathsOverlap(target, constraint.check.target)) {
			signals.push({
				type: "constraint_risk",
				reason: `This action touches "${constraint.check.target}", which a hard constraint protects: "${constraint.description}"`,
				origin: "contract",
				weight: 1,
				relatedItemIds: [constraint.id],
			});
			continue;
		}

		const match = matchConstraintToAction(constraint.description, action);
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
		if (forbidden.priority !== "hard") continue;
		const match = matchConstraintToAction(forbidden.description, action);
		if (!match.relevant) continue;
		signals.push({
			type: "constraint_risk",
			reason: `This action has capabilities that can reach forbidden condition: "${forbidden.description}"`,
			origin: "contract",
			weight: match.violates ? 1 : 0.8,
			relatedItemIds: [forbidden.id],
		});
	}

	return signals;
}

/**
 * Decide relevance before policy. Absolute prohibitions become deterministic violations;
 * conditional language such as "avoid unnecessary dependencies" remains a semantic gate.
 */
export function matchConstraintToAction(description: string, action: ProposedAction): ConstraintActionMatch {
	const expected = relevantCapabilities(description);
	const matched = expected.filter((capability) => action.actionSemantics.capabilities.includes(capability));
	const lower = description.toLowerCase();

	const scopeConstraint =
		/(outside|only (?:in|inside|within)|must remain within|do not modify files outside)/i.test(description) &&
		/\b(path|folder|directory|file)\w*/i.test(description);
	if (
		scopeConstraint &&
		action.actionSemantics.capabilities.some((capability) =>
			capability === "write_file" || capability === "delete_file" || capability === "move_file"
		)
	) {
		if (action.actionSemantics.targetOwnership === "outside_scope") {
			return {
				relevant: true,
				violates: true,
				reason: `The action targets ${action.actionSemantics.target ?? "(unknown path)"} outside the allowed task scope.`,
				capabilities: action.actionSemantics.capabilities,
			};
		}
		if (action.actionSemantics.targetOwnership === "task_created") {
			return {
				relevant: false,
				violates: false,
				reason: "The target is task-owned and therefore inside the permitted construction scope.",
				capabilities: [],
			};
		}
		return {
			relevant: true,
			violates: false,
			reason: "The action mutates a path whose task-scope ownership is not established.",
			capabilities: action.actionSemantics.capabilities,
		};
	}

	if (matched.length === 0) {
		return { relevant: false, violates: false, reason: "No action capability can materially affect this constraint.", capabilities: [] };
	}

	const absolute = /\b(do not|don't|must not|never|no (?:commit|push|delet|deploy|publish|database)|without (?:any )?commit)\b/i.test(
		description,
	);
	const existingDelete =
		matched.includes("delete_file") &&
		/\b(existing|pre-existing|preexisting)\b/i.test(lower) &&
		action.actionSemantics.targetOwnership === "preexisting";
	const qualifiedDelete =
		matched.includes("delete_file") &&
		/\b(existing|pre-existing|preexisting)\b/i.test(lower) &&
		action.actionSemantics.targetOwnership !== "preexisting";
	if (qualifiedDelete) {
		return {
			relevant: false,
			violates: false,
			reason: "The constraint protects existing files; this target was created by the task.",
			capabilities: [],
		};
	}
	const conditional = /\b(unnecessary|unless|required|only if|after|before|without verification|avoid)\b/i.test(description);
	const violates = existingDelete || (absolute && !conditional && !qualifiedDelete);

	return {
		relevant: true,
		violates,
		reason: violates
			? `The action capability ${matched.join(", ")} directly violates hard constraint: "${description}"`
			: `The action capability ${matched.join(", ")} can materially affect hard constraint: "${description}"`,
		capabilities: matched,
	};
}

export function externalMutationSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (!action.actionSemantics.externalSideEffect) return undefined;
	return {
		type: "external_mutation",
		reason: "This action changes state outside the local task.",
		origin: "generic",
		weight: 0.85,
		relatedItemIds: [],
	};
}

export function destructiveSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (!action.actionSemantics.capabilities.includes("delete_file")) return undefined;
	return {
		type: "destructive",
		reason:
			action.actionSemantics.targetOwnership === "preexisting"
				? "This action deletes a pre-existing target."
				: "This action invokes an actual file deletion operation.",
		origin: "generic",
		weight: 0.85,
		relatedItemIds: [],
	};
}

export function irreversibleSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (action.actionSemantics.reversibility !== "low") return undefined;
	if (action.actionSemantics.capabilities.includes("delete_file") || action.actionSemantics.externalSideEffect) return undefined;
	return {
		type: "irreversible",
		reason: "This action has a low-reversibility side effect.",
		origin: "generic",
		weight: 0.8,
		relatedItemIds: [],
	};
}

export function protectedPathSignals(protectedPaths: readonly string[], action: ProposedAction): CheckpointSignal[] {
	if (!isMutating(action) || !action.actionSemantics.target) return [];
	const signals: CheckpointSignal[] = [];
	for (const protectedPath of protectedPaths) {
		if (!pathsOverlap(action.actionSemantics.target, protectedPath)) continue;
		signals.push({
			type: "constraint_risk",
			reason: `This action touches "${protectedPath}", which project configuration marks as protected.`,
			origin: "project",
			weight: 1,
			relatedItemIds: [],
		});
	}
	return signals;
}

export function isMutating(action: ProposedAction): boolean {
	return action.actionSemantics.mutationType !== "read" && action.actionSemantics.mutationType !== "none";
}

export function actionText(action: ProposedAction): string {
	return semanticActionText(action);
}

export function extractPathLikeTokens(action: ProposedAction): string[] {
	return action.actionSemantics.target ? [action.actionSemantics.target] : [];
}

export function pathsOverlap(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (!na || !nb) return false;
	return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`) || na.includes(`/${nb}/`) || na.endsWith(`/${nb}`);
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

const STOP_WORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	with: true,
	from: true,
	that: true,
	this: true,
	into: true,
	only: true,
	should: true,
	must: true,
};

export function overlapScore(description: string, haystack: string): number {
	const words = tokenize(description);
	if (words.length === 0) return 0;
	let hits = 0;
	for (const word of words) {
		if (haystack.includes(word)) hits++;
	}
	return hits / words.length;
}

function tokenize(text: string): string[] {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
		const word = raw.replace(/^[-.]+|[-.]+$/g, "");
		if (word.length >= 3 && !(word in STOP_WORDS)) out.add(word);
	}
	return [...out];
}

function relevantCapabilities(description: string): ActionCapability[] {
	const text = description.toLowerCase();
	const capabilities: ActionCapability[] = [];
	if (/\b(dependenc|package|library|libraries)\w*/.test(text)) capabilities.push("change_dependencies");
	if (/\b(push|remote|publish|upload|send|external)\w*/.test(text)) capabilities.push("mutate_remote");
	if (/\b(commit|committed)\b/.test(text)) capabilities.push("commit_git");
	if (/\b(delete|deletion|remove|removal|unlink|erase|destroy)\w*/.test(text)) capabilities.push("delete_file");
	if (/\b(deploy|deployment|release|production|ship)\w*/.test(text)) capabilities.push("deploy");
	if (/\b(database|db|sql|migration|migrate)\w*/.test(text)) capabilities.push("mutate_database");
	if (/\b(write|modify|edit|outside)\w*/.test(text) || /\b(touch|change|stay|remain)\w*.+\b(path|folder|directory|file)\w*/.test(text)) {
		capabilities.push("write_file", "move_file");
	}
	if (/\b(test|tests|testing|verify|verification)\w*/.test(text)) capabilities.push("run_tests");
	return [...new Set(capabilities)];
}
