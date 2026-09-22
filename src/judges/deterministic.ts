import type { JudgeConfig } from "../config/schema.ts";
import type { AssessQuery, Judge, JudgeDecision, JudgeQuery, JudgeStats } from "./judge.ts";
import { emptyStats } from "./judge.ts";

/**
 * The deterministic Judge: the last link in the fallback chain (§41).
 *
 * No network, no model, no failure mode. It cannot reason, so it does not pretend to:
 * it applies one rule that needs no intelligence at all —
 *
 *     a hard requirement with no supporting runtime evidence is not satisfied.
 *
 * That is enough to catch the single most common and most damaging failure: declaring
 * success, or performing an irreversible action, when nothing has actually been
 * verified. It will never return PASS on a critical checkpoint; the best it offers is
 * REVIEW, which puts a human in the loop.
 *
 * Its value is that it is always available. When the network is down and the model is
 * unreachable, the harness still refuses to wave through an unverified `push`.
 */
export function createDeterministicJudge(options: { config: JudgeConfig }): Judge {
	let stats: JudgeStats = emptyStats();

	return {
		id: "deterministic",

		async isAvailable(): Promise<boolean> {
			return true;
		},

		async evaluate(query: JudgeQuery): Promise<JudgeDecision> {
			stats = { ...stats, calls: stats.calls + 1 };

			const reasons: string[] = [
				"Evaluated by the deterministic rule engine; no decision model was available.",
			];
			const missingEvidence: string[] = [];
			const requirementSupport: Record<string, number> = {};
			let unverifiableHard = 0;

			// Which requirements have any current runtime evidence attached?
			const covered = new Set<string>();
			for (const item of query.state.evidence) {
				covered.add(item.requirement);
			}

			for (const requirement of query.requirements) {
				// Evidence is matched by description, which is how the payload builder emits it.
				const hasEvidence = covered.has(requirement.description) || covered.has(requirement.id);
				requirementSupport[requirement.id] = hasEvidence ? 0.6 : 0;
				if (hasEvidence || requirement.priority !== "hard") continue;

				/**
				 * Demand more evidence only where evidence can exist. A requirement with no
				 * typed verification route will never acquire linked runtime evidence, so
				 * MORE_EVIDENCE would send the worker on an errand it cannot complete — and
				 * it would come back, and be sent again. That item goes to a human instead.
				 */
				if (requirement.verifiable === false) {
					unverifiableHard++;
					reasons.push(`Hard requirement "${requirement.description}" has no typed verification route; a human must judge it.`);
					continue;
				}
				missingEvidence.push(`${requirement.id}: ${requirement.description} — no runtime evidence has been collected.`);
				reasons.push(`Hard requirement "${requirement.description}" has no supporting runtime evidence.`);
			}

			const isCritical = query.checkpointType !== "progress_stall" && query.checkpointType !== "claim_promotion";

			if (missingEvidence.length > 0) {
				return {
					decision: "MORE_EVIDENCE",
					confidence: 1, // Certainty about absence, not about correctness.
					reasons,
					missingEvidence,
					stateVersion: query.stateVersion,
					judgeId: "deterministic",
					detail: { requirementSupport },
				};
			}

			/**
			 * Every hard requirement has *some* evidence. Whether that evidence actually
			 * demonstrates the requirement is a judgement this engine cannot make, so it
			 * hands the decision to a human rather than inventing a PASS.
			 */
			const needsHuman = isCritical || unverifiableHard > 0;
			reasons.push(
				needsHuman
					? unverifiableHard > 0
						? `${unverifiableHard} hard requirement(s) cannot be verified by the harness and need a human decision.`
						: "All hard requirements have supporting evidence, but assessing whether that evidence is sufficient requires a decision model. Escalating to human review."
					: "All hard requirements have supporting evidence. This checkpoint is not critical, so it proceeds.",
			);

			return {
				decision: needsHuman ? "REVIEW" : "PASS",
				confidence: needsHuman ? 0 : options.config.thresholds.minPassConfidence,
				reasons,
				missingEvidence: [],
				stateVersion: query.stateVersion,
				judgeId: "deterministic",
				detail: { requirementSupport },
			};
		},

		/**
		 * With no way to reason about the question, return the escalation threshold
		 * exactly. The caller's comparison is `>=`, so an unanswerable question resolves
		 * toward gating — the conservative direction.
		 */
		async assess(_query: AssessQuery): Promise<number> {
			stats = { ...stats, calls: stats.calls + 1 };
			return options.config.thresholds.checkpointNeeded;
		},

		stats: () => stats,
	};
}
