import { type Static, Type } from "typebox";

/**
 * Global harness configuration (§48).
 *
 * This file may be read by anyone with access to the machine and may be copied
 * between environments, so it carries **no secrets** — the API key comes from the
 * environment or the 0600 secret store, never from here (§32/§42).
 */

export const JudgeFailurePolicySchema = Type.Union(
	[Type.Literal("fail_closed"), Type.Literal("user_review"), Type.Literal("fallback"), Type.Literal("fail_open")],
	{ description: "What to do when no Judge can produce a decision." },
);
export type JudgeFailurePolicy = Static<typeof JudgeFailurePolicySchema>;

export const JudgeConfigSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),
		provider: Type.String({ default: "openrouter", description: "Which Judge adapter to use as primary." }),
		baseUrl: Type.String({ default: "https://openrouter.ai/api" }),
		/**
		 * Jev is a System One model: it is served from a decisions endpoint, not from
		 * `/v1/chat/completions`. OpenRouter still has this on its alpha path, so it is
		 * configurable rather than baked in.
		 */
		decisionsPath: Type.String({ default: "/alpha/decisions" }),
		model: Type.String({ default: "~typesafe/jev-latest" }),
		timeoutMs: Type.Integer({ default: 30_000, minimum: 1_000, maximum: 300_000 }),
		maxRetries: Type.Integer({ default: 2, minimum: 0, maximum: 5 }),
		/** Ordered adapter names tried when the primary Judge cannot answer. */
		fallbackChain: Type.Array(Type.String(), { default: ["model", "deterministic"] }),
		failurePolicy: Type.Object(
			{
				critical: Type.Union(
					[
						Type.Literal("fail_closed"),
						Type.Literal("user_review"),
						Type.Literal("fallback"),
						Type.Literal("fail_open"),
					],
					{ default: "user_review" },
				),
				noncritical: Type.Union(
					[
						Type.Literal("fail_closed"),
						Type.Literal("user_review"),
						Type.Literal("fallback"),
						Type.Literal("fail_open"),
					],
					{ default: "fallback" },
				),
			},
			{ default: {} },
		),
		/** Probability thresholds applied to Jev's calibrated outputs. */
		thresholds: Type.Object(
			{
				/** A requirement is "supported" at or above this probability. */
				requirementSupported: Type.Number({ default: 0.75, minimum: 0, maximum: 1 }),
				/** A hard constraint is "violated" at or above this probability. */
				constraintViolated: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
				/** Below this confidence a PASS is downgraded to REVIEW. */
				minPassConfidence: Type.Number({ default: 0.6, minimum: 0, maximum: 1 }),
				/** Checkpoint escalation threshold for the ambiguous-action noul. */
				checkpointNeeded: Type.Number({ default: 0.6, minimum: 0, maximum: 1 }),
			},
			{ default: {} },
		),
		/** USD per million input tokens, for the estimate in `/harness judge`. */
		inputCostPerMillion: Type.Number({ default: 0.042, minimum: 0 }),
		/**
		 * Budget for the fallback *model* Judge, per attempt. Separate from `timeoutMs`
		 * because that one bounds an HTTP call to Jev, while this bounds a structured
		 * completion from whatever chat model Pi is on — which on a local machine can
		 * be slow. Unbounded, a stalled fallback Judge stalls every gate for minutes.
		 */
		modelFallbackTimeoutMs: Type.Integer({ default: 90_000, minimum: 5_000, maximum: 1_800_000 }),
		modelFallbackRepairAttempts: Type.Integer({ default: 1, minimum: 0, maximum: 5 }),
	},
	{ default: {} },
);
export type JudgeConfig = Static<typeof JudgeConfigSchema>;

/**
 * `current-pi-model` uses whatever model the user has selected, which is what keeps
 * the harness model-agnostic. A concrete `provider/model` pin is allowed for people
 * who want a cheap dedicated compiler.
 */
const providerRefFields = {
	provider: Type.String({ default: "current-pi-model" }),
	model: Type.Optional(Type.String()),
	maxRepairAttempts: Type.Integer({ default: 2, minimum: 0, maximum: 5 }),
	/**
	 * Budget for a single call, per attempt.
	 *
	 * Generous by default because a large local model on modest hardware is genuinely
	 * slow, and cutting it off early would be worse than waiting. But unbounded is not
	 * an option: without this, a stalled model stalls the whole Pi session with no way
	 * out and nothing on screen explaining why.
	 */
	timeoutMs: Type.Integer({ default: 180_000, minimum: 5_000, maximum: 1_800_000 }),
	/**
	 * Thinking effort for this role's calls. A harness call is "emit one JSON
	 * document that satisfies this schema"; it does not need a reasoning model to
	 * deliberate for 20,000 tokens. One live compile spent 22k output tokens and
	 * 138 seconds, most of it thinking. Minimal is the default; raise it for a
	 * role if its output quality actually suffers.
	 */
	reasoning: Type.Union([Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "minimal" }),
	/** Hard cap on output tokens per call. A contract or review fits comfortably. */
	maxOutputTokens: Type.Integer({ default: 8_000, minimum: 500, maximum: 200_000 }),
};

export const ProviderRefSchema = Type.Object(providerRefFields, { default: {} });
export type ProviderRef = Static<typeof ProviderRefSchema>;

export const HarnessConfigSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),

		compiler: Type.Object(providerRefFields, {
			default: {},
			description: "Builds the Task Contract from the raw user request.",
		}),
		contractReviewer: Type.Object(
			{ ...providerRefFields, enabled: Type.Boolean({ default: true }) },
			{ default: {}, description: "Independently reviews the compiler's output." },
		),

		judge: JudgeConfigSchema,

		checkpoints: Type.Object(
			{
				/**
				 * Ask the Judge when deterministic signals are inconclusive. Costs a call
				 * per ambiguous action; disable it to gate only on contract-derived signals.
				 */
				escalateAmbiguous: Type.Boolean({ default: true }),
				/** Gate a completion claim even when the contract named no critical actions. */
				alwaysGateCompletion: Type.Boolean({ default: true }),
			},
			{ default: {} },
		),

		contract: Type.Object(
			{
				/**
				 * `substantive` compiles a contract only for requests that look like real
				 * tasks; `always` compiles for every prompt; `off` requires `/harness task`.
				 * The heuristic behind `substantive` is documented in contract/compiler.ts.
				 */
				autoCompile: Type.Union([Type.Literal("substantive"), Type.Literal("always"), Type.Literal("off")], {
					default: "substantive",
				}),
				/** Minimum prompt length, in characters, for the `substantive` heuristic. */
				substantiveMinChars: Type.Integer({ default: 40, minimum: 0 }),
			},
			{ default: {} },
		),

		progress: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				/**
				 * How many times an equivalent action may repeat before the monitor reports
				 * a loop. This is a *harness* safety net, not a task rule — a user-specified
				 * limit becomes a hard contract constraint instead (§43).
				 */
				repeatActionThreshold: Type.Integer({ default: 3, minimum: 2, maximum: 50 }),
				noNewEvidenceTurns: Type.Integer({ default: 4, minimum: 2, maximum: 50 }),
				/**
				 * How many times a rejected completion may restart the worker. Beyond this,
				 * or when the worker made no progress since the last rejection, the harness
				 * stops the loop and hands the decision to the user. Without a cap, a
				 * condition nothing can verify keeps the model circling forever.
				 */
				maxCompletionRejections: Type.Integer({ default: 2, minimum: 0, maximum: 20 }),
			},
			{ default: {} },
		),

		state: Type.Object(
			{
				persist: Type.Boolean({ default: true }),
				/** Snapshot every N events. The event log remains the source of truth. */
				snapshotEveryEvents: Type.Integer({ default: 25, minimum: 1, maximum: 1000 }),
				/** Task directories older than this are pruned by `/harness prune`. */
				retainTaskDays: Type.Integer({ default: 30, minimum: 1, maximum: 3650 }),
				/**
				 * An unfinished task is resumed on session start only if it was last touched
				 * within this window. Yesterday's contract must not silently govern today's
				 * unrelated prompt in the same directory.
				 */
				resumeWithinHours: Type.Number({ default: 12, minimum: 0, maximum: 24 * 365 }),
			},
			{ default: {} },
		),

		logging: Type.Object(
			{
				level: Type.Union(
					[
						Type.Literal("debug"),
						Type.Literal("info"),
						Type.Literal("warn"),
						Type.Literal("error"),
						Type.Literal("silent"),
					],
					{ default: "info" },
				),
			},
			{ default: {} },
		),

		ui: Type.Object(
			{
				/** Show the contract/state summary in the Pi footer. */
				showStatus: Type.Boolean({ default: true }),
			},
			{ default: {} },
		),
	},
	{ default: {}, additionalProperties: false },
);
export type HarnessConfig = Static<typeof HarnessConfigSchema>;

/**
 * Optional project-local configuration: `<project>/.pi/harness.json` (§47).
 *
 * This only *helps* the Evidence Planner find the right commands. It never replaces
 * Task Contract logic, and the harness works fine with no project config at all.
 */
export const ProjectConfigSchema = Type.Object(
	{
		projectType: Type.Optional(Type.String()),
		preferredCommands: Type.Optional(Type.Record(Type.String(), Type.String())),
		/** Paths that must never be modified, regardless of task. Merged in as hard constraints. */
		protectedPaths: Type.Optional(Type.Array(Type.String())),
		/** Extra context handed to the Task Compiler. */
		notes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ProjectConfig = Static<typeof ProjectConfigSchema>;
