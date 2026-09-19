/**
 * The Judge interface (§29).
 *
 * Core harness logic depends on *this file only*. It knows nothing about OpenRouter,
 * TypeSafe, HTTP or any model. `OpenRouterJevJudge` is one implementation among
 * several, and swapping it must require no change above this line (§65.14, §65.15).
 *
 * The shape of this interface was determined by what Jev actually is. Jev is a
 * System One model: it does not emit prose, it answers *typed questions* with
 * calibrated probabilities. So the interface is expressed in typed questions too.
 * A prose-based Judge (see `model-judge.ts`) adapts itself to this shape, rather
 * than the shape being bent toward prose and then awkwardly constrained.
 *
 * The payoff is that `reasons` and `missingEvidence` are derived deterministically in
 * `normalize.ts` from probabilities, instead of being generated text we have to trust.
 */

export type JudgeVerdict = "PASS" | "FAIL" | "MORE_EVIDENCE" | "REVIEW";

/** Judge output, normalized (§39). Raw provider responses never escape an adapter. */
export interface JudgeDecision {
	readonly decision: JudgeVerdict;
	/** 0..1. From Jev this is a calibrated confidence, not a self-report. */
	readonly confidence: number;
	readonly reasons: readonly string[];
	/** Descriptions of what is still needed. Non-empty implies MORE_EVIDENCE. */
	readonly missingEvidence: readonly string[];
	/** The state version this decision was computed against (§20, §65.18). */
	readonly stateVersion: number;
	/** Which adapter produced it, for provenance in the audit log. */
	readonly judgeId: string;
	readonly latencyMs?: number;
	/** Per-item probabilities, for explainability. */
	readonly detail?: {
		readonly requirementSupport?: Readonly<Record<string, number>>;
		readonly constraintViolation?: Readonly<Record<string, number>>;
		readonly verdictProbabilities?: Readonly<Record<string, number>>;
	};
	readonly usage?: { input?: number; output?: number };
	readonly debug?: {
		readonly requestHash: string;
		readonly semanticHash: string;
		readonly evidenceIds: readonly string[];
		readonly request: unknown;
		readonly response: unknown;
	};
}

/**
 * A gate evaluation request.
 *
 * `state` is built by the harness from canonical state, never by the worker model
 * (§38). `agentAssessment` is the one place a worker opinion may appear, and it is
 * explicitly labelled untrusted so no Judge can mistake it for evidence.
 */
export interface JudgeQuery {
	/** Compact, harness-built payload (§37). See `payload.ts`. */
	readonly state: JudgeState;
	/** Requirements to evaluate individually, by id. */
	readonly requirements: ReadonlyArray<{ id: string; description: string; priority: "hard" | "soft" }>;
	/** Hard constraints to check the proposed action against, by id. */
	readonly constraints: ReadonlyArray<{ id: string; description: string }>;
	readonly checkpointType: string;
	readonly stateVersion: number;
	readonly signal?: AbortSignal | undefined;
}

/** Everything the Judge is told about the world. Deliberately small. */
export interface JudgeState {
	readonly phase: string;
	readonly normalizedAction: Readonly<{
		actionType: string;
		target?: string;
		targetOwnership: string;
		mutationType: string;
		reversibility: string;
		externalSideEffect: boolean;
		capabilities: readonly string[];
	}>;
	readonly goal: string;
	readonly checkpoint: string;
	readonly proposedAction: string;
	readonly proposedActionArguments?: unknown;
	readonly userInstructions: readonly string[];
	readonly relevantRequirements: readonly string[];
	readonly hardConstraints: readonly string[];
	readonly forbiddenConditions: readonly string[];
	readonly verifiedFacts: readonly string[];
	readonly evidence: ReadonlyArray<{ requirement: string; type: string; source: string; result: string; observedAt: string }>;
	readonly evidenceBundles: ReadonlyArray<{
		readonly requirementId: string;
		readonly selected: ReadonlyArray<{
			id: string;
			type: string;
			source: string;
			result: string;
			trust: string;
			selectionReason: string;
			observedAt: string;
		}>;
		readonly excluded: ReadonlyArray<{ id: string; reason: string }>;
	}>;
	readonly hypotheses: readonly string[];
	readonly recentActions: readonly string[];
	readonly counters: Readonly<Record<string, number>>;
	readonly stateVersion: number;
	/** Untrusted. Included for context only; never treated as evidence (§38). */
	readonly agentAssessment?: string;
}

/** A single yes/no question with calibrated output. Used for cheap escalation checks. */
export interface AssessQuery {
	readonly state: unknown;
	readonly question: string;
	readonly criteria?: { true: string; false: string };
	readonly stateVersion: number;
	readonly signal?: AbortSignal | undefined;
}

export interface Judge {
	readonly id: string;
	/** Whether this Judge can currently answer. Checked before use, not by throwing. */
	isAvailable(): Promise<boolean>;
	/** Full gate evaluation. */
	evaluate(query: JudgeQuery): Promise<JudgeDecision>;
	/** One probability for one question. Cheaper than `evaluate` (§23 escalation). */
	assess(query: AssessQuery): Promise<number>;
	/** Usage accounting for `/harness judge` (§55). */
	stats(): JudgeStats;
}

export interface JudgeStats {
	readonly calls: number;
	readonly retries: number;
	readonly failures: number;
	readonly totalLatencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Undefined when the provider gives no pricing information. */
	readonly estimatedCostUsd?: number;
}

export const emptyStats = (): JudgeStats => ({
	calls: 0,
	retries: 0,
	failures: 0,
	totalLatencyMs: 0,
	inputTokens: 0,
	outputTokens: 0,
});

/**
 * §20/§65.19: a decision computed against an older state version must not be applied.
 *
 * The world moved while the Judge was thinking, so its verdict is about a state that
 * no longer exists. Re-evaluate rather than act on it.
 */
export function isStale(decision: JudgeDecision, currentStateVersion: number): boolean {
	return decision.stateVersion < currentStateVersion;
}

export const VERDICT_OPTIONS: readonly JudgeVerdict[] = ["PASS", "FAIL", "MORE_EVIDENCE", "REVIEW"];

export function isVerdict(value: unknown): value is JudgeVerdict {
	return typeof value === "string" && (VERDICT_OPTIONS as readonly string[]).includes(value);
}
