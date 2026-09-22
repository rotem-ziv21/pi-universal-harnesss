import type { JudgeConfig } from "../config/schema.ts";
import type { JudgeDecision, JudgeQuery, JudgeVerdict } from "./judge.ts";

/**
 * Turning typed answers into a normalized decision (§39).
 *
 * This is where the design pays off. Jev returns:
 *   - a `choice` over PASS/FAIL/MORE_EVIDENCE/REVIEW, with probabilities
 *   - one `noul` per requirement: "is this sufficiently supported by the evidence?"
 *   - one `noul` per hard constraint: "would this action violate it?"
 *
 * `reasons` and `missingEvidence` are then computed **in code** from those numbers.
 * No prose is parsed, nothing is hallucinated, and the same explanation is produced
 * for the same probabilities every time. The confidence attached to the result is
 * Jev's calibrated confidence rather than a model's opinion of itself.
 *
 * Three consistency rules are applied, in order. They exist because a raw verdict can
 * contradict the per-item answers, and when it does, the per-item answers win — they
 * are narrower questions and therefore better answered.
 */

export interface TypedAnswers {
	readonly verdict?: { choice: string; probabilities: Record<string, number>; confidence: number };
	/** requirementId -> probability that it is sufficiently supported */
	readonly requirementSupport: Record<string, number>;
	/** constraintId -> probability that the proposed action violates it */
	readonly constraintViolation: Record<string, number>;
}

export function normalizeDecision(args: {
	answers: TypedAnswers;
	query: JudgeQuery;
	config: JudgeConfig;
	judgeId: string;
	latencyMs: number;
	usage?: { input?: number; output?: number };
}): JudgeDecision {
	const { answers, query, config, judgeId, latencyMs } = args;
	const { requirementSupported, constraintViolated, minPassConfidence } = config.thresholds;

	const reasons: string[] = [];
	const missingEvidence: string[] = [];

	// --- per-constraint: a violated hard constraint is decisive ---
	const violations: string[] = [];
	for (const constraint of query.constraints) {
		const p = answers.constraintViolation[constraint.id];
		if (p === undefined) continue;
		if (p >= constraintViolated) {
			violations.push(constraint.id);
			reasons.push(`Hard constraint "${constraint.description}" would be violated (p=${fmt(p)}).`);
		}
	}

	// --- per-requirement: unsupported hard requirements are what is missing ---
	const unsupportedHard: string[] = [];
	for (const requirement of query.requirements) {
		const p = answers.requirementSupport[requirement.id];
		if (p === undefined) continue;

		if (p >= requirementSupported) {
			reasons.push(`Requirement "${requirement.description}" is supported by the evidence (p=${fmt(p)}).`);
		} else if (requirement.priority === "hard") {
			unsupportedHard.push(requirement.id);
			missingEvidence.push(
				`${requirement.id}: ${requirement.description} — not sufficiently supported (p=${fmt(p)}).` +
					(requirement.verifiable === false
						? " The harness has no typed check for this; demonstrate it with a tool result (run a test, a listing, a diff, a check)."
						: ""),
			);
			reasons.push(`Requirement "${requirement.description}" lacks sufficient evidence (p=${fmt(p)}).`);
		} else {
			reasons.push(`Soft requirement "${requirement.description}" is weakly supported (p=${fmt(p)}); not blocking.`);
		}
	}

	let verdict: JudgeVerdict = answers.verdict && isKnownVerdict(answers.verdict.choice) ? answers.verdict.choice : "REVIEW";
	let confidence = answers.verdict?.confidence ?? 0.5;

	if (!answers.verdict) {
		reasons.push("No overall verdict was returned; the decision was derived from the per-item answers alone.");
	}

	// Rule 1 — a violated hard constraint overrides any verdict. Nothing outranks this.
	if (violations.length > 0 && verdict !== "FAIL") {
		reasons.unshift(`Overriding the returned verdict "${verdict}": a hard constraint would be violated.`);
		verdict = "FAIL";
		confidence = Math.max(confidence, maxOf(answers.constraintViolation, violations));
	}

	// Rule 2 — a PASS with unsupported hard requirements is not a PASS.
	if (verdict === "PASS" && unsupportedHard.length > 0) {
		reasons.unshift(
			`Overriding the returned verdict "PASS": ${unsupportedHard.length} hard requirement(s) lack sufficient evidence.`,
		);
		verdict = "MORE_EVIDENCE";
	}

	// Rule 3 — a low-confidence PASS becomes a REVIEW rather than a coin flip.
	if (verdict === "PASS" && confidence < minPassConfidence) {
		reasons.unshift(`Downgrading PASS to REVIEW: confidence ${fmt(confidence)} is below the ${fmt(minPassConfidence)} threshold.`);
		verdict = "REVIEW";
	}

	// Keep the contract of the type honest: MORE_EVIDENCE must say what is missing.
	if (verdict === "MORE_EVIDENCE" && missingEvidence.length === 0) {
		missingEvidence.push("The Judge requested more evidence but did not identify a specific gap. Collect evidence for the checkpoint's requirements.");
	}

	if (reasons.length === 0) {
		reasons.push(`The Judge returned ${verdict} with no per-item detail.`);
	}

	return {
		decision: verdict,
		confidence: clamp01(confidence),
		reasons,
		missingEvidence,
		stateVersion: query.stateVersion,
		judgeId,
		latencyMs,
		detail: {
			requirementSupport: answers.requirementSupport,
			constraintViolation: answers.constraintViolation,
			...(answers.verdict ? { verdictProbabilities: answers.verdict.probabilities } : {}),
		},
		...(args.usage ? { usage: args.usage } : {}),
	};
}

/** A decision produced without any Judge, when policy says to block anyway (§40). */
export function unavailableDecision(args: {
	query: JudgeQuery;
	judgeId: string;
	verdict: JudgeVerdict;
	reason: string;
}): JudgeDecision {
	return {
		decision: args.verdict,
		confidence: 0,
		reasons: [args.reason],
		missingEvidence: args.verdict === "MORE_EVIDENCE" ? ["No Judge was available to evaluate the evidence."] : [],
		stateVersion: args.query.stateVersion,
		judgeId: args.judgeId,
	};
}

const isKnownVerdict = (v: string): v is JudgeVerdict => v === "PASS" || v === "FAIL" || v === "MORE_EVIDENCE" || v === "REVIEW";

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const fmt = (n: number): string => n.toFixed(2);

function maxOf(record: Record<string, number>, keys: readonly string[]): number {
	let max = 0;
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value > max) max = value;
	}
	return max;
}
