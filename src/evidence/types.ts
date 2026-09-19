import type { VerificationStrategy } from "../contract/schema.ts";
import type { FreshnessClass, TrustLevel } from "../state/types.ts";

export interface EvidenceRequest {
	readonly id: string;
	readonly requirementIds: readonly string[];
	readonly description: string;
	readonly strategy: VerificationStrategy;
	readonly necessity: "required" | "optional";
	readonly cost: "cheap" | "moderate" | "expensive";
	readonly freshnessClass: FreshnessClass;
}

export interface EvidencePlan {
	readonly checkpointId: string;
	readonly requirementsToVerify: readonly string[];
	readonly evidenceRequests: readonly EvidenceRequest[];
	readonly alreadySatisfied: readonly string[];
	readonly unverifiable: ReadonlyArray<{ requirementId: string; reason: string }>;
	readonly preferredEvaluators: readonly string[];
}

export interface CollectedEvidence {
	readonly requestId: string;
	readonly requirementIds: readonly string[];
	readonly type: VerificationStrategy["kind"];
	readonly summary: string;
	readonly result: "supported" | "contradicted" | "unknown";
	readonly observed: unknown;
	readonly expected?: unknown;
	readonly value: unknown;
	readonly sourceType: "tool" | "command" | "file" | "api" | "model" | "user" | "harness" | "subagent";
	readonly source: string;
	readonly provenance: string;
	readonly trust: TrustLevel;
	readonly freshnessClass: FreshnessClass;
	readonly validity?: string;
	readonly error?: string;
}

export interface CollectionResult {
	readonly collected: readonly CollectedEvidence[];
	readonly failed: ReadonlyArray<{ requestId: string; reason: string }>;
	readonly durationMs: number;
}
