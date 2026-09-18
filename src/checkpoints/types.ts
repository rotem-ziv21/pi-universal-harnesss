/**
 * Checkpoint vocabulary (§23).
 *
 * Every type here is phrased in terms of *what an action does to the world*, never in
 * terms of which tool performs it. "external_mutation" covers `git push`, a `curl -X
 * POST`, an S3 upload and sending an email equally well, which is the entire point.
 */

export type CheckpointType =
	/** The contract explicitly named this action as requiring verification. */
	| "contract_critical_action"
	/** Proceeding could violate a hard constraint or reach a forbidden condition. */
	| "constraint_risk"
	/** Changes state outside this machine or visible to other people. */
	| "external_mutation"
	/** Cannot be undone from within the task. */
	| "irreversible"
	/** Destroys or overwrites existing data. */
	| "destructive"
	/** The worker is asserting a hypothesis has become fact. */
	| "claim_promotion"
	/** The worker is declaring the task finished. */
	| "completion_claim"
	/** The progress monitor believes the current approach is looping. */
	| "progress_stall";

export type CheckpointSeverity = "critical" | "noncritical";

/** One reason the detector thinks a gate is needed, with its provenance. */
export interface CheckpointSignal {
	readonly type: CheckpointType;
	readonly reason: string;
	/** `contract` signals are exact. `generic` signals are documented heuristics. */
	readonly origin: "contract" | "generic" | "judge" | "project";
	/** 0..1. Contract-derived signals are 1. */
	readonly weight: number;
	readonly relatedItemIds: readonly string[];
}

/** The action the worker proposes, described without reference to any specific tool. */
export interface ProposedAction {
	readonly id: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	/** One-line human description, used in prompts, logs and block messages. */
	readonly summary: string;
	/** Stable hash of the normalized input, for loop detection. */
	readonly signature: string;
}

export interface CheckpointDecision {
	readonly needsGate: boolean;
	readonly checkpointType?: CheckpointType;
	readonly severity: CheckpointSeverity;
	readonly reason: string;
	readonly signals: readonly CheckpointSignal[];
	/** Contract item ids the gate should verify before allowing the action. */
	readonly relatedRequirements: readonly string[];
	/** True when deterministic signals were inconclusive and the Judge was consulted. */
	readonly escalated: boolean;
}

export const NO_GATE: CheckpointDecision = {
	needsGate: false,
	severity: "noncritical",
	reason: "No checkpoint signals matched this action.",
	signals: [],
	relatedRequirements: [],
	escalated: false,
};

/**
 * Types that are treated as critical for the Judge failure policy (§40).
 *
 * When the Judge is unreachable, a critical checkpoint must not be waved through.
 */
export const CRITICAL_TYPES: ReadonlySet<CheckpointType> = new Set([
	"contract_critical_action",
	"constraint_risk",
	"irreversible",
	"destructive",
	"external_mutation",
	"completion_claim",
]);

export function severityFor(type: CheckpointType): CheckpointSeverity {
	return CRITICAL_TYPES.has(type) ? "critical" : "noncritical";
}
