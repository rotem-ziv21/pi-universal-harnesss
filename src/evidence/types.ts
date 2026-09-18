import type { FreshnessClass, TrustLevel } from "../state/types.ts";

/**
 * Evidence vocabulary (§24, §28).
 *
 * Request *kinds* are generic capabilities — run a command, hash a file, ask a
 * reviewer. The concrete content comes from the Task Contract. That split is what
 * lets the same planner serve a git checkpoint, a dataset checkpoint and an image
 * checkpoint without knowing anything about any of them.
 */

export type EvidenceRequestKind =
	/** Run a shell command and read its exit code and output. */
	| "command"
	/** Hash or stat a path to prove it did or did not change. */
	| "file_state"
	/** Read something a tool already produced earlier in this task. */
	| "prior_tool_output"
	/** Ask a reviewer agent or model a focused question. */
	| "reviewer"
	/** A check the harness performs itself, with no external call. */
	| "internal";

export interface EvidenceRequest {
	readonly id: string;
	/** Contract item ids this evidence would bear on. */
	readonly requirementIds: readonly string[];
	readonly kind: EvidenceRequestKind;
	/** What we are trying to establish, in plain language. */
	readonly description: string;
	/** Kind-specific parameters. `command` → {command}; `file_state` → {path}; etc. */
	readonly parameters: Record<string, unknown>;
	/** `required` gaps block the gate; `optional` ones only enrich it. */
	readonly necessity: "required" | "optional";
	/** Cheap requests are collected first so an early FAIL costs little. */
	readonly cost: "cheap" | "moderate" | "expensive";
	readonly freshnessClass: FreshnessClass;
}

export interface EvidencePlan {
	readonly checkpointId: string;
	readonly requirementsToVerify: readonly string[];
	readonly evidenceRequests: readonly EvidenceRequest[];
	/** Requirements already covered by fresh evidence; nothing new is needed. */
	readonly alreadySatisfied: readonly string[];
	/** Requirements with no available way to gather evidence, and why. */
	readonly unverifiable: ReadonlyArray<{ requirementId: string; reason: string }>;
	readonly preferredEvaluators: readonly string[];
}

export interface CollectedEvidence {
	readonly requestId: string;
	readonly requirementIds: readonly string[];
	readonly type: string;
	readonly summary: string;
	readonly value: unknown;
	readonly sourceType: "tool" | "command" | "file" | "api" | "model" | "user" | "harness" | "subagent";
	readonly source: string;
	readonly trust: TrustLevel;
	readonly freshnessClass: FreshnessClass;
	readonly validity?: string;
	readonly ok: boolean;
	readonly error?: string;
}

export interface CollectionResult {
	readonly collected: readonly CollectedEvidence[];
	readonly failed: ReadonlyArray<{ requestId: string; reason: string }>;
	readonly durationMs: number;
}
