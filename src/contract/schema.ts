import { type Static, Type } from "typebox";

/**
 * The Universal Task Contract (§7, §8).
 *
 * The single most important property of this file: **the schema is fixed, the content
 * is not**. There is nothing here about git, tests, datasets, images or code. A
 * dataset task and an image task produce structurally identical contracts that differ
 * only in their strings.
 *
 * If you ever find yourself wanting to add a field like `testCommand` or
 * `requiresCleanWorktree`, that belongs in the *content* of a requirement, not in
 * this schema.
 */

/** Where a statement came from. Drives trust level (§17) and is never inferred later. */
export const SourceSchema = Type.Union(
	[Type.Literal("user"), Type.Literal("compiler"), Type.Literal("runtime"), Type.Literal("system")],
	{
		description:
			"user = stated explicitly by the user (authoritative). compiler = derived best practice. " +
			"runtime = discovered during execution. system = harness invariant.",
	},
);
export type ContractSource = Static<typeof SourceSchema>;

/**
 * `hard` may not be traded away. `soft` is a preference.
 *
 * A user statement is hard by default. The compiler is explicitly forbidden from
 * downgrading "Do not touch production" into a preference (§13).
 */
export const PrioritySchema = Type.Union([Type.Literal("hard"), Type.Literal("soft")]);
export type Priority = Static<typeof PrioritySchema>;

const ResourceKindSchema = Type.Union([
	Type.Literal("file"),
	Type.Literal("directory"),
	Type.Literal("vcs_ref"),
	Type.Literal("api_object"),
	Type.Literal("database_record"),
	Type.Literal("deployment"),
	Type.Literal("artifact"),
	Type.Literal("remote_resource"),
	Type.Literal("unknown"),
]);

const ResourceOperationSchema = Type.Union([
	Type.Literal("read"),
	Type.Literal("create"),
	Type.Literal("modify"),
	Type.Literal("delete"),
	Type.Literal("move"),
	Type.Literal("execute"),
	Type.Literal("query"),
	Type.Literal("publish"),
	Type.Literal("deploy"),
]);

const ResourceProvenanceSchema = Type.Union([
	Type.Literal("preexisting"),
	Type.Literal("created_by_current_task"),
	Type.Literal("created_by_harness"),
	Type.Literal("external"),
	Type.Literal("unknown"),
]);

const ResourceScopeSchema = Type.Union([
	Type.Literal("allowed"),
	Type.Literal("protected"),
	Type.Literal("outside_allowed"),
	Type.Literal("external"),
	Type.Literal("unknown"),
]);

export const ActionCapabilitySchema = Type.Union([
	Type.Literal("read_resource"),
	Type.Literal("create_resource"),
	Type.Literal("modify_resource"),
	Type.Literal("delete_resource"),
	Type.Literal("move_resource"),
	Type.Literal("query_resource"),
	Type.Literal("execute_code"),
	Type.Literal("install_dependency"),
	Type.Literal("commit"),
	Type.Literal("mutate_remote"),
	Type.Literal("publish"),
	Type.Literal("deploy"),
	Type.Literal("generate_artifact"),
]);
export type ContractActionCapability = Static<typeof ActionCapabilitySchema>;

export const ActionSelectorSchema = Type.Object(
	{
		capabilities: Type.Optional(Type.Array(ActionCapabilitySchema)),
		operations: Type.Optional(Type.Array(ResourceOperationSchema)),
		resourceKinds: Type.Optional(Type.Array(ResourceKindSchema)),
		provenances: Type.Optional(Type.Array(ResourceProvenanceSchema)),
		scopes: Type.Optional(Type.Array(ResourceScopeSchema)),
		externalSideEffect: Type.Optional(Type.Boolean()),
		targetUriPrefix: Type.Optional(Type.String()),
		/**
		 * Resources the selector must NOT match, as URI prefixes or paths relative to
		 * the workspace. "Create nothing except summary.md" is
		 * `{operations:["create"], excludeTargets:["summary.md"]}`; without this the
		 * compiler could only forbid every creation, including the one the user asked for.
		 */
		excludeTargets: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
export type ActionSelector = Static<typeof ActionSelectorSchema>;

const OutputExpectationSchema = Type.Object(
	{
		operator: Type.Union([
			Type.Literal("equals"),
			Type.Literal("contains"),
			Type.Literal("matches"),
			Type.Literal("numeric_equals"),
			Type.Literal("numeric_greater_than"),
			Type.Literal("numeric_less_than"),
		]),
		value: Type.String(),
	},
	{ additionalProperties: false },
);

export const VerificationStrategySchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("command_execution"),
			program: Type.String({ minLength: 1 }),
			args: Type.Array(Type.String(), { default: [] }),
			cwd: Type.Optional(Type.String()),
			expectExitCode: Type.Integer({ default: 0 }),
			stdout: Type.Optional(OutputExpectationSchema),
			stderr: Type.Optional(OutputExpectationSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("resource_state"),
			resource: Type.String({ minLength: 1 }),
			condition: Type.Union([Type.Literal("exists"), Type.Literal("absent"), Type.Literal("hash_equals")]),
			expectedHash: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("event_log_assertion"),
			action: ActionSelectorSchema,
			operator: Type.Union([
				Type.Literal("equals"),
				Type.Literal("at_least"),
				Type.Literal("at_most"),
				Type.Literal("none"),
			]),
			count: Type.Integer({ minimum: 0, default: 0 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("semantic_evaluation"),
			instructions: Type.String({ minLength: 1 }),
			evidenceSources: Type.Array(Type.String(), { default: [] }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("visual_evaluation"),
			instructions: Type.String({ minLength: 1 }),
			resources: Type.Array(Type.String(), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("user_confirmation"),
			prompt: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export type VerificationStrategy = Static<typeof VerificationStrategySchema>;

export const WorkspacePolicySchema = Type.Object(
	{
		allowedScopes: Type.Array(Type.String(), { default: [] }),
		protectedResources: Type.Array(Type.String(), { default: [] }),
	},
	{ additionalProperties: false },
);
export type ContractWorkspacePolicy = Static<typeof WorkspacePolicySchema>;

export const RequirementStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("satisfied"),
	Type.Literal("violated"),
	Type.Literal("unknown"),
]);
export type RequirementStatus = Static<typeof RequirementStatusSchema>;

export const RequirementSchema = Type.Object(
	{
		id: Type.String({ description: "Stable within a contract, e.g. r1, r2." }),
		description: Type.String({ minLength: 1 }),
		source: SourceSchema,
		priority: PrioritySchema,
		status: Type.Union([...RequirementStatusSchema.anyOf], { default: "pending" }),
		/** Verbatim user words this was derived from. Present only when source is "user". */
		quote: Type.Optional(Type.String()),
		/** Typed strategies only. Natural-language descriptions are never executed. */
		verification: Type.Optional(Type.Array(VerificationStrategySchema)),
	},
	{ additionalProperties: false },
);
export type Requirement = Static<typeof RequirementSchema>;

/**
 * A boundary on *how* the task may be performed, as opposed to what must be achieved.
 * "Do not modify the frontend" is a constraint; "authentication works" is a requirement.
 */
export const ConstraintSchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		source: SourceSchema,
		priority: PrioritySchema,
		quote: Type.Optional(Type.String()),
		/** Deterministic policy, when the statement can be expressed structurally. */
		policy: Type.Optional(
			Type.Object(
				{
					effect: Type.Union([Type.Literal("forbid"), Type.Literal("require_review")]),
					action: ActionSelectorSchema,
				},
				{ additionalProperties: false },
			),
		),
		verification: Type.Optional(Type.Array(VerificationStrategySchema)),
	},
	{ additionalProperties: false },
);
export type Constraint = Static<typeof ConstraintSchema>;

/** What must be demonstrably true for the task to count as done (§44). */
export const SuccessConditionSchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		source: SourceSchema,
		priority: PrioritySchema,
		/** Typed strategies only. Descriptive prose is never parsed as a command. */
		verification: Type.Optional(Type.Array(VerificationStrategySchema)),
		status: Type.Union([...RequirementStatusSchema.anyOf], { default: "pending" }),
	},
	{ additionalProperties: false },
);
export type SuccessCondition = Static<typeof SuccessConditionSchema>;

/** A state that must never be reached. Distinct from a constraint: this is an outcome. */
export const ForbiddenConditionSchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		source: SourceSchema,
		priority: PrioritySchema,
		policy: Type.Optional(
			Type.Object(
				{
					effect: Type.Literal("forbid"),
					action: ActionSelectorSchema,
				},
				{ additionalProperties: false },
			),
		),
		verification: Type.Optional(Type.Array(VerificationStrategySchema)),
	},
	{ additionalProperties: false },
);
export type ForbiddenCondition = Static<typeof ForbiddenConditionSchema>;

/**
 * An action the contract says must be verified before it happens (§23).
 *
 * Described in the vocabulary of the *task*, not of a tool. "publish the repository
 * changes", "overwrite the source dataset", "send the campaign". The Checkpoint
 * Detector matches proposed actions against these descriptions semantically; it does
 * not compare tool names.
 */
export const CriticalActionSchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		source: SourceSchema,
		/** Why this is dangerous — feeds the Judge payload and the block explanation. */
		rationale: Type.Optional(Type.String()),
		reversible: Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")], { default: "unknown" }),
		/** Requirement/success-condition ids that must hold before this action may run. */
		requiresVerificationOf: Type.Array(Type.String(), { default: [] }),
		/** Structured action match. Without it, relevance is a Judge decision, never regex dispatch. */
		action: Type.Optional(ActionSelectorSchema),
	},
	{ additionalProperties: false },
);
export type CriticalAction = Static<typeof CriticalActionSchema>;

/** Something the compiler could not resolve. Surfaced to the user rather than guessed. */
export const AmbiguitySchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		/** How the harness will proceed unless the user says otherwise. */
		defaultInterpretation: Type.Optional(Type.String()),
		blocking: Type.Boolean({ default: false }),
	},
	{ additionalProperties: false },
);
export type Ambiguity = Static<typeof AmbiguitySchema>;

/**
 * Something the compiler filled in that the user did not say.
 *
 * Kept separate from requirements so that an assumption can never be presented back
 * to the Judge as a user instruction (§13, §38).
 */
export const AssumptionSchema = Type.Object(
	{
		id: Type.String(),
		description: Type.String({ minLength: 1 }),
		confidence: Type.Number({ minimum: 0, maximum: 1, default: 0.5 }),
	},
	{ additionalProperties: false },
);
export type Assumption = Static<typeof AssumptionSchema>;

export const TaskContractSchema = Type.Object(
	{
		id: Type.String(),
		version: Type.Integer({ minimum: 1, default: 1 }),

		/** The user's words, unmodified. The ground truth every other field answers to. */
		originalRequest: Type.String(),
		goal: Type.String({ minLength: 1 }),
		workspace: Type.Optional(WorkspacePolicySchema),

		requirements: Type.Array(RequirementSchema, { default: [] }),
		constraints: Type.Array(ConstraintSchema, { default: [] }),
		successConditions: Type.Array(SuccessConditionSchema, { default: [] }),
		forbiddenConditions: Type.Array(ForbiddenConditionSchema, { default: [] }),
		criticalActions: Type.Array(CriticalActionSchema, { default: [] }),
		ambiguities: Type.Array(AmbiguitySchema, { default: [] }),
		assumptions: Type.Array(AssumptionSchema, { default: [] }),

		metadata: Type.Object(
			{
				createdAt: Type.String(),
				/** Free-text domain label from the compiler. Descriptive only — never dispatched on. */
				domain: Type.Optional(Type.String()),
				cwd: Type.Optional(Type.String()),
				compiledBy: Type.Optional(Type.String()),
				reviewedBy: Type.Optional(Type.String()),
				/** Set once the contract is locked; the worker may not mutate it after this. */
				lockedAt: Type.Optional(Type.String()),
			},
			{ default: {}, additionalProperties: true },
		),
	},
	{ additionalProperties: false },
);
export type TaskContract = Static<typeof TaskContractSchema>;

/**
 * What the compiler model is asked to produce.
 *
 * Narrower than the full contract: ids, versions and timestamps are assigned by the
 * harness, not by the model. A model that invents its own `version` field cannot
 * confuse the revision history.
 */
export const CompiledContractSchema = Type.Object(
	{
		goal: Type.String({ minLength: 1 }),
		domain: Type.Optional(Type.String()),
		requirements: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				source: SourceSchema,
				priority: PrioritySchema,
				quote: Type.Optional(Type.String()),
				verification: Type.Optional(Type.Array(VerificationStrategySchema)),
			}),
			{ default: [] },
		),
		constraints: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				source: SourceSchema,
				priority: PrioritySchema,
				quote: Type.Optional(Type.String()),
				policy: Type.Optional(
					Type.Object(
						{
							effect: Type.Union([Type.Literal("forbid"), Type.Literal("require_review")]),
							action: ActionSelectorSchema,
						},
						{ additionalProperties: false },
					),
				),
				verification: Type.Optional(Type.Array(VerificationStrategySchema)),
			}),
			{ default: [] },
		),
		successConditions: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				source: SourceSchema,
				priority: PrioritySchema,
				verification: Type.Optional(Type.Array(VerificationStrategySchema)),
			}),
			{ default: [] },
		),
		forbiddenConditions: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				source: SourceSchema,
				priority: PrioritySchema,
				policy: Type.Optional(
					Type.Object(
						{
							effect: Type.Literal("forbid"),
							action: ActionSelectorSchema,
						},
						{ additionalProperties: false },
					),
				),
				verification: Type.Optional(Type.Array(VerificationStrategySchema)),
			}),
			{ default: [] },
		),
		criticalActions: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				source: SourceSchema,
				rationale: Type.Optional(Type.String()),
				reversible: Type.Optional(Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")])),
				action: Type.Optional(ActionSelectorSchema),
			}),
			{ default: [] },
		),
		ambiguities: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				defaultInterpretation: Type.Optional(Type.String()),
				blocking: Type.Optional(Type.Boolean()),
			}),
			{ default: [] },
		),
		assumptions: Type.Array(
			Type.Object({
				description: Type.String({ minLength: 1 }),
				confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			}),
			{ default: [] },
		),
		workspace: Type.Optional(WorkspacePolicySchema),
	},
	{ additionalProperties: false },
);
export type CompiledContract = Static<typeof CompiledContractSchema>;

// --- lookup helpers used across the harness ---

export type ContractItem = Requirement | Constraint | SuccessCondition | ForbiddenCondition | CriticalAction;

export function findContractItem(contract: TaskContract, id: string): ContractItem | undefined {
	return (
		contract.requirements.find((r) => r.id === id) ??
		contract.constraints.find((c) => c.id === id) ??
		contract.successConditions.find((s) => s.id === id) ??
		contract.forbiddenConditions.find((f) => f.id === id) ??
		contract.criticalActions.find((a) => a.id === id)
	);
}

export function describeContractItem(contract: TaskContract, id: string): string {
	return findContractItem(contract, id)?.description ?? `(unknown item ${id})`;
}

/** Everything that may not be traded away, in one list. */
export function hardConstraints(contract: TaskContract): Constraint[] {
	return contract.constraints.filter((c) => c.priority === "hard");
}

export function hardRequirements(contract: TaskContract): Requirement[] {
	return contract.requirements.filter((r) => r.priority === "hard");
}

/** Statements the user made explicitly. These outrank every model interpretation. */
export function userStatements(contract: TaskContract): Array<{ id: string; description: string; priority: Priority }> {
	const out: Array<{ id: string; description: string; priority: Priority }> = [];
	for (const r of contract.requirements) if (r.source === "user") out.push(r);
	for (const c of contract.constraints) if (c.source === "user") out.push(c);
	for (const s of contract.successConditions) if (s.source === "user") out.push(s);
	for (const f of contract.forbiddenConditions) if (f.source === "user") out.push(f);
	return out;
}
