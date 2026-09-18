import type { ProposedAction } from "../checkpoints/types.ts";
import type { HarnessConfig } from "../config/schema.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { HarnessState } from "../state/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";

/**
 * The Progress Monitor (§43).
 *
 * Detects the failure modes that make long-running agents expensive: repeating an
 * equivalent action, retrying a strategy that already failed, and grinding through
 * turns without producing new evidence.
 *
 * The critical design rule from §43: **do not hardcode "stop after 10 attempts".**
 * The thresholds here are harness safety nets that produce *advice*. A user-specified
 * limit is a different thing entirely — it becomes a hard contract constraint, and
 * `checkUserLimits` enforces it as a stop rather than a suggestion.
 */

export type ProgressAction = "CONTINUE" | "CHANGE_STRATEGY" | "STOP_BRANCH" | "MORE_EVIDENCE" | "NEEDS_USER_INPUT";

export interface ProgressObservation {
	readonly action: ProgressAction;
	readonly reason: string;
	/** Present when the trigger was an explicit user limit rather than a heuristic. */
	readonly contractItemId?: string;
	readonly detail: Readonly<Record<string, number | string>>;
}

export const CONTINUE: ProgressObservation = { action: "CONTINUE", reason: "Progress looks normal.", detail: {} };

export interface ProgressMonitor {
	/** Called before a tool runs. */
	observeAction(args: { contract: TaskContract; state: HarnessState; action: ProposedAction }): ProgressObservation;
	/** Called at the end of each turn. */
	observeTurn(args: { contract: TaskContract; state: HarnessState }): ProgressObservation;
}

export function createProgressMonitor(options: { config: HarnessConfig; logger?: Logger }): ProgressMonitor {
	const log = (options.logger ?? nullLogger).child("progress");
	const { progress } = options.config;

	/** Turns observed since the evidence count last increased. */
	let turnsWithoutNewEvidence = 0;
	let lastEvidenceCount = -1;

	return {
		observeAction({ contract, state, action }): ProgressObservation {
			if (!progress.enabled) return CONTINUE;

			// User-specified limits first: these are contract obligations, not advice.
			const userLimit = checkUserLimits(contract, state);
			if (userLimit) return userLimit;

			// How many times has this exact action already been proposed?
			const repeats = state.actions.filter((a) => a.signature === action.signature).length;

			if (repeats >= progress.repeatActionThreshold) {
				const failures = state.actions.filter((a) => a.signature === action.signature && a.outcome === "failed").length;

				log.warn("repeated action detected", { tool: action.toolName, repeats, failures });

				return {
					action: failures >= repeats ? "STOP_BRANCH" : "CHANGE_STRATEGY",
					reason:
						failures >= repeats
							? `This action has been attempted ${repeats} times and has failed every time. Repeating it will not help; a different approach is needed.`
							: `This action has already been performed ${repeats} times. If the situation has not changed, repeating it adds nothing.`,
					detail: { repeats, failures, tool: action.toolName },
				};
			}

			return CONTINUE;
		},

		observeTurn({ contract, state }): ProgressObservation {
			if (!progress.enabled) return CONTINUE;

			const userLimit = checkUserLimits(contract, state);
			if (userLimit) return userLimit;

			const evidenceCount = state.evidence.length;
			if (evidenceCount > lastEvidenceCount) {
				lastEvidenceCount = evidenceCount;
				turnsWithoutNewEvidence = 0;
			} else {
				turnsWithoutNewEvidence++;
			}

			if (turnsWithoutNewEvidence >= progress.noNewEvidenceTurns) {
				const observed = turnsWithoutNewEvidence;
				/**
				 * Report on crossing the threshold, not on every turn past it.
				 *
				 * Left as a simple `>=`, a long stretch of reading and thinking produces one
				 * warning per turn for the rest of the task. That is noise, and noise trains
				 * people to ignore the signal. Resetting the counter means the next report
				 * comes after another full interval of genuine stagnation.
				 */
				turnsWithoutNewEvidence = 0;
				log.warn("no new evidence for several turns", { turns: observed });
				return {
					action: "MORE_EVIDENCE",
					reason: `${observed} turns have produced no new runtime evidence. The task may be circling rather than converging.`,
					detail: { turnsWithoutNewEvidence: observed, evidenceCount },
				};
			}

			return CONTINUE;
		},
	};
}

/**
 * Enforce limits the *user* set (§43).
 *
 * "After 10 loops, stop" is a hard constraint with source `user`, and the harness
 * obeys it as a stop — not as a hint to the model, which would be free to ignore it.
 *
 * The parsing is intentionally narrow: a number next to a word naming what is counted.
 * A constraint the parser cannot read stays enforced the ordinary way, as a constraint
 * the Judge checks at gate time.
 */
export function checkUserLimits(contract: TaskContract, state: HarnessState): ProgressObservation | undefined {
	for (const constraint of contract.constraints) {
		if (constraint.source !== "user" || constraint.priority !== "hard") continue;

		const limit = parseNumericLimit(constraint.description);
		if (!limit) continue;

		const current = currentCountFor(limit.unit, state);
		if (current === undefined) continue;

		if (current >= limit.value) {
			return {
				action: "STOP_BRANCH",
				reason: `The user set a hard limit: "${constraint.description}". That limit has been reached (${current}/${limit.value} ${limit.unit}).`,
				contractItemId: constraint.id,
				detail: { limit: limit.value, current, unit: limit.unit },
			};
		}
	}
	return undefined;
}

type LimitUnit = "attempts" | "turns" | "tool_calls" | "blocks";

/** `"stop after 10 attempts"` → `{ value: 10, unit: "attempts" }`. */
export function parseNumericLimit(text: string): { value: number; unit: LimitUnit } | undefined {
	const match = /\b(\d{1,4})\s*(attempts?|tries|retries|iterations?|loops?|turns?|steps?|tool calls?|blocks?)\b/i.exec(text);
	if (!match?.[1] || !match[2]) return undefined;

	const value = Number.parseInt(match[1], 10);
	if (!Number.isFinite(value) || value <= 0) return undefined;

	const word = match[2].toLowerCase();
	const unit: LimitUnit = /turn|step|iteration|loop/.test(word)
		? "turns"
		: /block/.test(word)
			? "blocks"
			: /tool call/.test(word)
				? "tool_calls"
				: "attempts";

	return { value, unit };
}

function currentCountFor(unit: LimitUnit, state: HarnessState): number | undefined {
	switch (unit) {
		case "turns":
			return state.counters.turns;
		case "tool_calls":
			return state.counters.toolCalls;
		case "blocks":
			return state.counters.blocks;
		case "attempts": {
			/**
			 * "Attempts" means repeated tries at the same thing, not total tool calls —
			 * counting every call would trip a limit of 10 almost immediately in any real
			 * task and make the harness unusable.
			 */
			const bySignature = new Map<string, number>();
			for (const action of state.actions) {
				bySignature.set(action.signature, (bySignature.get(action.signature) ?? 0) + 1);
			}
			return Math.max(0, ...bySignature.values());
		}
	}
}
