import { type Static, Type } from "typebox";

/**
 * Global harness configuration.
 *
 * This file may be read by anyone with access to the machine and may be copied
 * between environments, so it carries **no secrets**. The API key comes from Pi's
 * own `/login`, the environment, or the 0600 secret store, never from here.
 *
 * Keys from earlier versions (compiler, contractReviewer, checkpoints, contract,
 * progress, state) are ignored with a warning; see `LEGACY_KEYS`.
 */

export const JudgeConfigSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),
		baseUrl: Type.String({ default: "https://openrouter.ai/api" }),
		/** Jev is served from a decisions endpoint, not from chat completions. */
		decisionsPath: Type.String({ default: "/alpha/decisions" }),
		/**
		 * Thresholds are tuned to a model version. Pin a versioned id here once one is
		 * confirmed on OpenRouter; every decision logs the model that actually answered.
		 */
		model: Type.String({ default: "~typesafe/jev-latest" }),
		/** One budget for a whole decision, retries included. A late answer is worthless to a gate. */
		timeoutMs: Type.Integer({ default: 8_000, minimum: 1_000, maximum: 120_000 }),
		/** USD per million input tokens, for the estimate in `/harness status`. */
		inputCostPerMillion: Type.Number({ default: 0.042, minimum: 0 }),
	},
	{ default: {} },
);
export type JudgeConfig = Static<typeof JudgeConfigSchema>;

export const HarnessConfigSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),
		/**
		 * `enforce` holds and nudges. `observe` only logs what it would have done, so the
		 * thresholds can be checked against real traffic first. The short deny list of
		 * catastrophic commands applies in both.
		 */
		mode: Type.Union([Type.Literal("enforce"), Type.Literal("observe")], { default: "enforce" }),

		judge: JudgeConfigSchema,

		action: Type.Object(
			{
				/** Probabilities from Jev's action questions. See src/decide/policy.ts. */
				destructiveConfirm: Type.Number({ default: 0.8, minimum: 0, maximum: 1 }),
				exfiltrationBlock: Type.Number({ default: 0.8, minimum: 0, maximum: 1 }),
				outwardConfirm: Type.Number({ default: 0.85, minimum: 0, maximum: 1 }),
				offRequestConfirm: Type.Number({ default: 0.9, minimum: 0, maximum: 1 }),
			},
			{ default: {} },
		),

		done: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				claimsDone: Type.Number({ default: 0.7, minimum: 0, maximum: 1 }),
				applies: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
				/** Per requested item: shown by the evidence at or above itemDone, not shown at or below itemNotDone, uncertain between. */
				itemDone: Type.Number({ default: 0.8, minimum: 0, maximum: 1 }),
				itemNotDone: Type.Number({ default: 0.2, minimum: 0, maximum: 1 }),
				/** The final message claims results the evidence does not show. */
				claimBeyond: Type.Number({ default: 0.7, minimum: 0, maximum: 1 }),
				/** How many times one user prompt may send the worker back. After that the run ends, reported as unverified. */
				maxNudgesPerPrompt: Type.Integer({ default: 1, minimum: 0, maximum: 3 }),
				maxNudgesPerSession: Type.Integer({ default: 3, minimum: 0, maximum: 20 }),
			},
			{ default: {} },
		),

		stuck: Type.Object(
			{
				/** Identical failing calls before a note is appended to the result. */
				repeatThreshold: Type.Integer({ default: 3, minimum: 2, maximum: 20 }),
			},
			{ default: {} },
		),

		logging: Type.Object(
			{
				level: Type.Union(
					[Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error"), Type.Literal("silent")],
					{ default: "info" },
				),
			},
			{ default: {} },
		),

		ui: Type.Object(
			{
				showStatus: Type.Boolean({ default: true }),
			},
			{ default: {} },
		),
	},
	{ default: {} },
);
export type HarnessConfig = Static<typeof HarnessConfigSchema>;

/** Top-level keys the previous, contract-based harness used. Ignored now. */
export const LEGACY_KEYS = ["compiler", "contractReviewer", "checkpoints", "contract", "progress", "state"] as const;

/**
 * Optional project-local configuration: `<project>/.pi/harness.json`, honoured only
 * for trusted projects.
 */
export const ProjectConfigSchema = Type.Object(
	{
		projectType: Type.Optional(Type.String()),
		/** Commands this project uses to check its work. Running one counts as a check. */
		preferredCommands: Type.Optional(Type.Record(Type.String(), Type.String())),
		/** Paths that must never be written without the user's say-so. */
		protectedPaths: Type.Optional(Type.Array(Type.String())),
		notes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ProjectConfig = Static<typeof ProjectConfigSchema>;
