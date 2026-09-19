export type ResourceKind =
	| "file"
	| "directory"
	| "vcs_ref"
	| "api_object"
	| "database_record"
	| "deployment"
	| "artifact"
	| "remote_resource"
	| "unknown";

export type ResourceProvenance =
	| "preexisting"
	| "created_by_current_task"
	| "created_by_harness"
	| "external"
	| "unknown";

export type ResourceScope = "allowed" | "protected" | "outside_allowed" | "external" | "unknown";

export type ResourceOperation = "read" | "create" | "modify" | "delete" | "move" | "execute" | "query" | "publish" | "deploy";

export interface ResourceEffect {
	readonly uri: string;
	readonly kind: ResourceKind;
	readonly operation: ResourceOperation;
	readonly provenance: ResourceProvenance;
	readonly scope: ResourceScope;
	readonly reversible: boolean;
	readonly external: boolean;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResourceRecord {
	readonly uri: string;
	readonly kind: ResourceKind;
	readonly provenance: ResourceProvenance;
	readonly scope: ResourceScope;
	readonly status: "active" | "deleted";
	readonly createdByActionId?: string;
	readonly lastActionId: string;
	readonly lastOperation: ResourceOperation;
	readonly updatedAt: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WorkspacePolicy {
	readonly allowedScopes?: readonly string[];
	readonly protectedResources?: readonly string[];
}

export interface TaskWorkspaceState {
	readonly initialWorkingDirectory: string;
	readonly allowedScopes: readonly string[];
	readonly protectedResources: readonly string[];
	readonly resources: readonly ResourceRecord[];
}
