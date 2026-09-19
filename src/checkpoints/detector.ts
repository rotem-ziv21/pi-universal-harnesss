import type { HarnessConfig } from "../config/schema.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { Judge } from "../judges/judge.ts";
import type { HarnessState } from "../state/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import {
	constraintRiskSignals,
	contractCriticalActionSignals,
	destructiveSignal,
	externalMutationSignal,
	irreversibleSignal,
	isMutating,
	matchConstraintToAction,
	matchesActionSelector,
	protectedPathSignals,
	scopeViolationSignals,
	unknownClassificationSignal,
} from "./signals.ts";
import {
	type CheckpointDecision,
	type CheckpointSignal,
	type CheckpointType,
	NO_GATE,
	type ProposedAction,
	severityFor,
} from "./types.ts";

/**
 * The Checkpoint Detector (§23).
 *
 * Decides whether a proposed action needs verification before it runs. What it is
 * *not*: a list of dangerous commands. The contract decides what matters for this
 * task; the generic signals are only a safety net for what the contract did not
 * anticipate.
 *
 * Three tiers, cheapest first:
 *
 *   1. Contract signals. Exact, free, decisive.
 *   2. Generic signals. Free, heuristic. Strong ones gate on their own; weak ones
 *      accumulate.
 *   3. Judge escalation. Costs one call. Only for genuinely ambiguous mutating
 *      actions, and only when `checkpoints.escalateAmbiguous` is on.
 *
 * Read-only actions exit at the top with no I/O at all. That fast path is what makes
 * the harness usable — most tool calls in any task are reads.
 */

export interface CheckpointDetector {
	evaluate(args: {
		contract: TaskContract;
		state: HarnessState;
		action: ProposedAction;
		protectedPaths?: readonly string[];
		signal?: AbortSignal | undefined;
	}): Promise<CheckpointDecision>;

	/** Completion claims are gated through their own path (§44), not through a tool call. */
	evaluateCompletion(args: { contract: TaskContract; state: HarnessState }): CheckpointDecision;
}

/** A single generic signal at or above this weight justifies a gate on its own. */
const STRONG_SIGNAL = 0.8;
/** Accumulated generic weight at or above this also justifies a gate. */
const ACCUMULATED = 1.2;
/** Below this, an ambiguous mutating action is not even worth asking the Judge about. */
const ESCALATION_FLOOR = 0.4;

export function createCheckpointDetector(options: {
	config: HarnessConfig;
	judge?: Judge | undefined;
	logger?: Logger;
}): CheckpointDetector {
	const log = (options.logger ?? nullLogger).child("checkpoints");

	return {
		async evaluate({ contract, state, action, protectedPaths = [], signal }): Promise<CheckpointDecision> {
			if (!isMutating(action)) return NO_GATE;

			// Tier 1: typed forbidden policies and protected scopes are deterministic.
			const directSignals: CheckpointSignal[] = [];
			for (const constraint of contract.constraints) {
				if (constraint.priority !== "hard" || constraint.policy?.effect !== "forbid") continue;
				const match = matchConstraintToAction(constraint, action);
				if (!match.violates) continue;
				directSignals.push({
					type: "constraint_risk",
					reason: match.reason,
					origin: "contract",
					weight: 1,
					relatedItemIds: [constraint.id],
				});
			}
			for (const forbidden of contract.forbiddenConditions) {
				if (forbidden.priority !== "hard" || !forbidden.policy) continue;
				if (!matchesActionSelector(forbidden.policy.action, action)) continue;
				directSignals.push({
					type: "constraint_risk",
					reason: `The action directly reaches typed forbidden condition: "${forbidden.description}"`,
					origin: "contract",
					weight: 1,
					relatedItemIds: [forbidden.id],
				});
			}
			directSignals.push(...scopeViolationSignals(action));
			directSignals.push(...protectedPathSignals(protectedPaths, action));
			if (directSignals.length > 0) {
				return { ...decide(directSignals, false), policyDecision: "block" };
			}

			// Tier 2: capability-aware contract relevance. Conditional constraints gate;
			// unrelated constraints are absent rather than being inferred from payload words.
			const contractSignals = [
				...contractCriticalActionSignals(contract, action),
				...constraintRiskSignals(contract, action),
			];
			if (contractSignals.length > 0) {
				const decision = decide(contractSignals, false);
				log.info("checkpoint detected from contract", {
					tool: action.toolName,
					type: decision.checkpointType,
					signals: contractSignals.length,
				});
				return decision;
			}

			// Broad lifecycle phases govern reversibility, not task type.
			const phase = state.phase === "active" || state.phase === "build" ? "execute" : state.phase;
			if (
				(phase === "plan" || phase === "execute" || phase === "verify") &&
				action.actionSemantics.classification !== "unknown" &&
				action.actionSemantics.reversibility === "high" &&
				!action.actionSemantics.externalSideEffect &&
				action.actionSemantics.effects.every((effect) => effect.scope === "allowed" || effect.scope === "unknown")
			) {
				return {
					...NO_GATE,
					reason: `Allowed as reversible local work during ${phase.toUpperCase()}.`,
				};
			}

			// Tier 3: generic high-risk side effects not anticipated by the contract.
			const genericSignals = [
				externalMutationSignal(action),
				destructiveSignal(action),
				irreversibleSignal(action),
				unknownClassificationSignal(action),
			].filter((item): item is CheckpointSignal => item !== undefined);
			const strongest = Math.max(0, ...genericSignals.map((item) => item.weight));
			const total = genericSignals.reduce((sum, item) => sum + item.weight, 0);

			if (strongest >= STRONG_SIGNAL || total >= ACCUMULATED) {
				return decide(genericSignals, false);
			}

			if (!options.config.checkpoints.escalateAmbiguous || !options.judge || total < ESCALATION_FLOOR) return NO_GATE;
			return escalate({ contract, state, action, genericSignals, judge: options.judge, config: options.config, log, signal });
		},

		/**
		 * A completion claim is always a checkpoint when the contract has success
		 * conditions to check, because §44 forbids the model from declaring victory and
		 * bypassing verification. With no success conditions and nothing critical in the
		 * contract, there is genuinely nothing to verify and gating would be theatre.
		 */
		evaluateCompletion({ contract }): CheckpointDecision {
			const hasSomethingToVerify =
				contract.successConditions.length > 0 ||
				contract.requirements.some((r) => r.priority === "hard") ||
				contract.constraints.some((constraint) => constraint.priority === "hard") ||
				contract.forbiddenConditions.length > 0;

			if (!hasSomethingToVerify && !options.config.checkpoints.alwaysGateCompletion) {
				return NO_GATE;
			}
			if (!hasSomethingToVerify) {
				return {
					needsGate: true,
					checkpointType: "completion_claim",
					severity: "noncritical",
					reason: "The worker declared the task complete. The contract defines no success conditions, so only a sanity check is performed.",
					signals: [],
					relatedRequirements: [],
					policyDecision: "gate",
					escalated: false,
				};
			}

			return {
				needsGate: true,
				checkpointType: "completion_claim",
				severity: "critical",
				reason: "The worker declared the task complete. Completion requires contract evaluation before it is accepted.",
				signals: [
					{
						type: "completion_claim",
						reason: "Completion must be verified against the Task Contract.",
						origin: "contract",
						weight: 1,
						relatedItemIds: contract.successConditions.map((s) => s.id),
					},
				],
				relatedRequirements: [
					...contract.successConditions.map((s) => s.id),
					...contract.requirements.filter((r) => r.priority === "hard").map((r) => r.id),
					...contract.forbiddenConditions.map((f) => f.id),
					...contract.constraints.filter((constraint) => constraint.priority === "hard").map((constraint) => constraint.id),
				],
				policyDecision: "gate",
				escalated: false,
			};
		},
	};
}

/** Build a decision from signals. The highest-weight signal names the checkpoint. */
function decide(signals: readonly CheckpointSignal[], escalated: boolean): CheckpointDecision {
	if (signals.length === 0) return NO_GATE;

	const ranked = [...signals].sort((a, b) => b.weight - a.weight);
	const primary = ranked[0]!;
	const type: CheckpointType = primary.type;

	// Any critical signal makes the whole checkpoint critical, regardless of ordering.
	const severity = ranked.some((s) => severityFor(s.type) === "critical") ? "critical" : "noncritical";

	const relatedRequirements = [...new Set(signals.flatMap((s) => s.relatedItemIds))];

	return {
		needsGate: true,
		checkpointType: type,
		severity,
		reason: primary.reason,
		signals: ranked,
		policyDecision: "gate",
		relatedRequirements,
		escalated,
	};
}

/**
 * Ask the Judge whether an ambiguous action deserves a gate.
 *
 * A single `noul` question — cheap, fast, calibrated. If the Judge is unavailable the
 * detector gates anyway: when in doubt about whether to check, check. The cost of a
 * spurious gate is a prompt; the cost of a missed one is an unverified irreversible
 * action.
 */
async function escalate(args: {
	contract: TaskContract;
	state: HarnessState;
	action: ProposedAction;
	genericSignals: readonly CheckpointSignal[];
	judge: Judge;
	config: HarnessConfig;
	log: Logger;
	signal?: AbortSignal | undefined;
}): Promise<CheckpointDecision> {
	const { contract, action, genericSignals, judge, config, log } = args;

	try {
		const probability = await judge.assess({
			state: {
				goal: contract.goal,
				hardConstraints: contract.constraints.filter((c) => c.priority === "hard").map((c) => c.description),
				forbiddenConditions: contract.forbiddenConditions.map((f) => f.description),
				criticalActions: contract.criticalActions.map((a) => a.description),
				proposedAction: action.summary,
				proposedActionArguments: action.input,
			},
			question:
				"Should this proposed action be verified before it is allowed to run, because it is irreversible, " +
				"externally visible, destructive, or because it risks violating one of the stated constraints or " +
				"forbidden conditions?",
			criteria: {
				true: "The action should be verified first. It is irreversible, externally visible, destructive, or risks a stated constraint.",
				false: "The action is routine and safely reversible within this task. No verification is needed.",
			},
			stateVersion: args.state.stateVersion,
			...(args.signal ? { signal: args.signal } : {}),
		});

		if (probability >= config.judge.thresholds.checkpointNeeded) {
			log.info("checkpoint escalated and confirmed by judge", { tool: action.toolName, probability });
			return decide(
				[
					...genericSignals,
					{
						type: genericSignals[0]?.type ?? "irreversible",
						reason: `The Judge assessed this action as requiring verification (p=${probability.toFixed(2)}).`,
						origin: "judge",
						weight: probability,
						relatedItemIds: [],
					},
				],
				true,
			);
		}

		log.debug("checkpoint escalated and declined by judge", { tool: action.toolName, probability });
		return { ...NO_GATE, escalated: true, reason: `The Judge assessed no verification is needed (p=${probability.toFixed(2)}).` };
	} catch (e) {
		// Fail toward gating: an unavailable Judge must not become a way through.
		log.warn("checkpoint escalation failed; gating conservatively", {
			tool: action.toolName,
			error: e instanceof Error ? e.message : String(e),
		});
		return decide(
			[
				...genericSignals,
				{
					type: "irreversible",
					reason: "The action was ambiguous and the Judge could not be reached, so it is gated conservatively.",
					origin: "generic",
					weight: 0.5,
					relatedItemIds: [],
				},
			],
			true,
		);
	}
}
