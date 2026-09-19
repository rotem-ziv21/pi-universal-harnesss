import type { ContractRevision } from "../contract/revisions.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { ActionSemantics, CheckpointSignal } from "../checkpoints/types.ts";

/**
 * Canonical state (§16) and the event vocabulary (§19).
 *
 * The model does not own any of this. It may read it, reason about it, and disagree
 * with it, but the harness is the source of truth and the model's claims enter here
 * only as hypotheses or as clearly-labelled `agentAssessment`.
 */

export type TaskPhase =
	| "compiling"
	| "reviewing"
	| "awaiting_user"
	| "plan"
	| "build"
	| "verify"
	| "finalize"
	| "completed"
	| "abandoned"
	/** Accepted when replaying task logs written by harness versions before phase-aware gating. */
	| "active"
	| "gating"
	| "blocked"
	| "completing";

/** §17 trust levels, as a type rather than a convention. */
export type TrustLevel =
	/** Level 1 — runtime evidence. Tool results, exit codes, hashes. Highest trust. */
	| "runtime_evidence"
	/** Level 2 — explicit user instruction. Authoritative for scope and intent. */
	| "user_instruction"
	/** Level 3 — model interpretation. Lowest trust until supported by Level 1. */
	| "model_interpretation";

/**
 * How long an observation stays meaningful (§21).
 *
 * `persistent`   - a user constraint; true for the session unless the user changes it
 * `until_change` - a file hash; true until that file is written
 * `temporary`    - an HTTP probe; true at the moment of observation and decays
 * `expiring`     - a token; has an explicit expiry
 */
export type FreshnessClass = "persistent" | "until_change" | "temporary" | "expiring";

export interface EvidenceRef {
	readonly id: string;
	readonly requirementIds: readonly string[];
	readonly type: string;
	readonly summary: string;
	readonly sourceType: "tool" | "command" | "file" | "api" | "model" | "user" | "harness" | "subagent";
	readonly source: string;
	readonly observedAt: string;
	readonly stateVersion: number;
	readonly freshnessClass: FreshnessClass;
	readonly trust: TrustLevel;
	/** Deterministic interpretation of the observation itself. */
	readonly result: "supported" | "contradicted" | "unknown";
	/** Set when superseded by a later, contradicting observation (§22). History is never deleted. */
	readonly supersededBy?: string;
	readonly supersededAt?: string;
	/** For `until_change`: what invalidates this. For `expiring`: an ISO timestamp. */
	readonly validity?: string;
	/** Full value, kept out of summaries so Judge payloads stay compact. */
	readonly value?: unknown;
}

/**
 * A verified fact (§18).
 *
 * The only way to create one is from Level 1 runtime evidence. "The model said so"
 * is not a path to this type — that is a `Hypothesis`.
 */
export interface VerifiedFact {
	readonly id: string;
	readonly statement: string;
	readonly evidenceIds: readonly string[];
	readonly observedAt: string;
	readonly stateVersion: number;
	readonly freshnessClass: FreshnessClass;
	readonly supersededBy?: string;
	readonly supersededAt?: string;
}

/** A model's belief. Structurally distinct from a fact so it can never be mistaken for one. */
export interface Hypothesis {
	readonly id: string;
	readonly statement: string;
	readonly confidence: number;
	readonly status: "open" | "supported" | "rejected" | "promoted";
	readonly createdAt: string;
	readonly stateVersion: number;
	/** Evidence gathered for or against. Promotion to a fact requires Level 1 support. */
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly source: "model" | "harness";
}

export interface RecordedAction {
	readonly id: string;
	readonly toolName: string;
	readonly summary: string;
	/** Hash of the normalized arguments, for loop detection. */
	readonly signature: string;
	readonly at: string;
	readonly stateVersion: number;
	readonly actionSemantics: ActionSemantics;
	readonly outcome: "pending" | "allowed" | "blocked" | "succeeded" | "failed";
	readonly resultSummary?: string;
	readonly checkpointId?: string;
}

export interface CheckpointRecord {
	readonly id: string;
	readonly type: string;
	readonly reason: string;
	readonly actionId: string;
	readonly relatedRequirements: readonly string[];
	readonly severity: "critical" | "noncritical";
	readonly at: string;
	readonly stateVersion: number;
	readonly phase: TaskPhase;
	readonly actionSemantics: ActionSemantics;
	readonly signals: readonly CheckpointSignal[];
	readonly policyDecision: "allow" | "block" | "gate";
	readonly dependencyAnalysis?: {
		readonly dependsOnBlockedAction: boolean;
		readonly requirementIds: readonly string[];
		readonly reason: string;
	};
	readonly outcome?: "allowed" | "blocked" | "user_approved" | "user_rejected";
}

export interface JudgeDecisionRecord {
	readonly id: string;
	readonly checkpointId: string;
	readonly judgeId: string;
	readonly decision: "PASS" | "FAIL" | "MORE_EVIDENCE" | "REVIEW" | "STALE_DECISION" | "UNAVAILABLE";
	readonly confidence: number;
	readonly reasons: readonly string[];
	readonly missingEvidence: readonly string[];
	/** The state version the decision was computed against (§20). */
	readonly stateVersion: number;
	readonly at: string;
	readonly latencyMs?: number;
	readonly applied: boolean;
	readonly staleReason?: string;
	readonly detail?: {
		readonly requirementSupport?: Readonly<Record<string, number>>;
		readonly constraintViolation?: Readonly<Record<string, number>>;
		readonly verdictProbabilities?: Readonly<Record<string, number>>;
	};
	readonly debug?: {
		readonly requestHash: string;
		readonly semanticHash: string;
		readonly evidenceIds: readonly string[];
		readonly request: unknown;
		readonly response: unknown;
	};
}

export interface Counters {
	toolCalls: number;
	checkpoints: number;
	blocks: number;
	judgeCalls: number;
	judgeFailures: number;
	completionAttempts: number;
	contractRevisions: number;
	turns: number;
}

export type CompletionConditionStatus = "SATISFIED" | "UNSATISFIED" | "UNKNOWN";

export interface CompletionConditionResult {
	readonly id: string;
	readonly description: string;
	readonly priority: "hard" | "soft";
	readonly kind: "requirement" | "success" | "constraint" | "forbidden";
	readonly status: CompletionConditionStatus;
	readonly reason: string;
	readonly evidenceIds: readonly string[];
	readonly deterministic: boolean;
}

export interface CompletionEvaluation {
	readonly stateVersion: number;
	readonly evaluatedAt: string;
	readonly conditions: readonly CompletionConditionResult[];
}

export interface HarnessState {
	/** Incremented on every meaningful mutation (§20). Judge decisions reference it. */
	readonly stateVersion: number;
	readonly taskId: string;
	readonly phase: TaskPhase;
	readonly contract: TaskContract;
	readonly contractVersion: number;
	readonly revisions: readonly ContractRevision[];

	readonly verifiedFacts: readonly VerifiedFact[];
	readonly hypotheses: readonly Hypothesis[];
	readonly evidence: readonly EvidenceRef[];

	readonly actions: readonly RecordedAction[];
	readonly checkpoints: readonly CheckpointRecord[];
	readonly decisions: readonly JudgeDecisionRecord[];

	readonly counters: Counters;
	readonly startedAt: string;
	readonly updatedAt: string;
	/** Set when the completion gate refused, so the next attempt knows what was missing. */
	readonly lastCompletionFeedback?: string;
	readonly lastCompletionEvaluation?: CompletionEvaluation;
}

// --- events ---

export type HarnessEventType =
	| "task_created"
	| "contract_compiled"
	| "contract_reviewed"
	| "contract_locked"
	| "contract_revised"
	| "phase_changed"
	| "tool_proposed"
	| "checkpoint_detected"
	| "evidence_requested"
	| "tool_allowed"
	| "tool_blocked"
	| "tool_executed"
	| "tool_result"
	| "evidence_added"
	| "evidence_superseded"
	| "hypothesis_created"
	| "hypothesis_updated"
	| "hypothesis_rejected"
	| "fact_verified"
	| "fact_superseded"
	| "judge_requested"
	| "judge_decision"
	| "judge_unavailable"
	| "stale_decision_rejected"
	| "progress_observation"
	| "branch_stopped"
	| "user_intervention"
	| "completion_requested"
	| "completion_rejected"
	| "completion_evaluated"
	| "task_completed"
	| "task_abandoned";

export interface HarnessEvent {
	readonly id: string;
	readonly type: HarnessEventType;
	readonly at: string;
	readonly taskId: string;
	/** State version *after* this event is applied. */
	readonly stateVersion: number;
	readonly payload: Record<string, unknown>;
}

export const TERMINAL_PHASES: ReadonlySet<TaskPhase> = new Set(["completed", "abandoned"]);

export const isTerminal = (phase: TaskPhase): boolean => TERMINAL_PHASES.has(phase);
