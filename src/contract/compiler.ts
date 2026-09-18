import type { ProjectConfig } from "../config/schema.ts";
import type { ModelAdapter } from "../models/model-adapter.ts";
import { completeStructured } from "../models/structured.ts";
import { newTaskId, nowIso } from "../util/ids.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import {
	type CompiledContract,
	CompiledContractSchema,
	type TaskContract,
} from "./schema.ts";

/**
 * The Task Compiler (§12).
 *
 * Turns a raw request into a structured contract. The prompt below is the one place
 * in the harness where task semantics are discussed at all, and even here it stays
 * domain-neutral: it teaches the *distinctions* (user vs derived, hard vs soft,
 * requirement vs constraint) and never mentions code, git, tests or datasets.
 *
 * The examples span three unrelated domains on purpose. A compiler prompt that only
 * shows coding examples produces contracts that smell like coding for every task.
 */

export interface CompilerInput {
	readonly request: string;
	readonly cwd: string;
	/** Tool names currently available. Lets the compiler avoid requiring the impossible. */
	readonly availableTools: readonly string[];
	readonly projectConfig?: ProjectConfig | undefined;
	readonly signal?: AbortSignal | undefined;
	/** Present when re-compiling after a REVISE verdict from the reviewer. */
	readonly reviewFindings?: readonly string[] | undefined;
}

export interface TaskCompiler {
	compile(input: CompilerInput): Promise<TaskContract>;
}

const SYSTEM_PROMPT = `You compile a user's request into a structured Task Contract for an execution harness.

The harness is domain-agnostic. It governs software work, git operations, deployments, security audits, dataset preparation, image generation, data processing, model-training preparation, research, and general agent tasks. Your output must fit whichever of those this request is, without assuming it is any of them.

THE DISTINCTIONS THAT MATTER

1. source
   "user"     - the user stated this. Quote their words in "quote".
   "compiler" - you inferred it as good practice. The user never said it.
   Never mark your own inference as "user". This is the single most damaging
   error you can make: the harness treats "user" statements as authoritative and
   will block work to protect them.

2. priority
   "hard" - may not be traded away under any circumstances.
   "soft" - a preference; may yield to a hard item.
   An explicit user prohibition or requirement is "hard". Do not soften it.
   "Do not touch production" is hard. It is not "prefer not to touch production".
   Your own derived best practices are almost always "soft".

3. requirement vs constraint
   requirement - something that must be ACHIEVED.  ("authentication works again")
   constraint  - a boundary on HOW it may be done. ("do not modify the frontend")

4. successCondition vs requirement
   A success condition is what must be demonstrably TRUE and VERIFIABLE for the
   task to be finished. Write it so that evidence could settle it.
   Add "verificationHint" describing what would prove it, in general terms.

5. forbiddenCondition
   An outcome that must never occur, as opposed to an action that is forbidden.
   ("training data leaks into the validation split")

6. criticalAction
   An action that must be verified BEFORE it is performed, because it is
   irreversible, externally visible, destructive, or the user gated it.
   Describe it in the vocabulary of the task, not of a tool.
   Good: "publish the repository changes to the shared remote"
   Bad:  "run git push"
   Set "reversible" to "no" when the action cannot be undone.

7. ambiguity
   Something you genuinely could not determine. Give the interpretation you would
   default to. Mark "blocking": true only if proceeding under any interpretation
   could cause harm.

8. assumption
   Something you filled in that the user did not say. Keep these OUT of
   requirements and constraints. An assumption is never a user instruction.

RULES
- Be faithful, not thorough. Do not pad the contract with generic best practices.
- If the user gave a numeric limit ("stop after 10 attempts"), that is a hard
  constraint with source "user".
- If the request is trivial and carries no real obligations, return a minimal
  contract: a goal, and nothing else. Empty arrays are correct and expected.
- successConditions should be few and decisive. Three good ones beat ten vague ones.

EXAMPLES OF THE SHAPE (different domains, to show this is not about any one of them)

Request: "Fix the authentication bug. Do not touch the frontend. Run tests. Only push if everything is safe."
  goal: "Fix the backend authentication defect"
  constraints: [{description: "The frontend must not be modified", source: "user", priority: "hard", quote: "Do not touch the frontend"}]
  successConditions: [{description: "The authentication defect no longer reproduces", source: "user", priority: "hard", verificationHint: "The failing behaviour is exercised and now succeeds"},
                      {description: "The existing test suite passes", source: "user", priority: "hard", verificationHint: "Test runner reports zero failures"}]
  criticalActions: [{description: "Publish the repository changes to the shared remote", source: "user", rationale: "User gated this on everything being safe", reversible: "no"}]

Request: "Prepare a brand-classification dataset. Do not modify the original dataset. Avoid train/validation leakage."
  goal: "Produce a training-ready brand-classification dataset"
  constraints: [{description: "The original source dataset must remain unchanged", source: "user", priority: "hard", quote: "Do not modify the original dataset"}]
  forbiddenConditions: [{description: "Any sample appears in both the train and validation splits", source: "user", priority: "hard"}]
  successConditions: [{description: "Train and validation splits exist and are disjoint", source: "user", priority: "hard", verificationHint: "Split membership is compared and the intersection is empty"}]
  criticalActions: [{description: "Write over or finalize the dataset on disk", source: "compiler", rationale: "Destructive to prior output", reversible: "no"}]

Request: "Create an image about Kubernetes with the exact text 'Ship it safely' on the left."
  goal: "Produce the requested Kubernetes visual"
  requirements: [{description: "The image is thematically about Kubernetes", source: "user", priority: "hard", quote: "an image about Kubernetes"},
                 {description: "The image contains the exact text 'Ship it safely'", source: "user", priority: "hard", quote: "the exact text 'Ship it safely'"},
                 {description: "That text appears on the left side of the image", source: "user", priority: "hard", quote: "on the left"}]
  successConditions: [{description: "Text recognised in the image matches 'Ship it safely' exactly", source: "user", priority: "hard", verificationHint: "Text extracted from the generated image is compared character by character"},
                      {description: "The recognised text is positioned in the left portion of the image", source: "user", priority: "hard", verificationHint: "The text bounding box centre falls in the left half"}]`;

const EXAMPLE_OUTPUT: CompiledContract = {
	goal: "Short imperative statement of what must be achieved",
	domain: "free-text label, descriptive only",
	requirements: [{ description: "Something that must be achieved", source: "user", priority: "hard", quote: "user's words" }],
	constraints: [{ description: "A boundary on how it may be done", source: "user", priority: "hard", quote: "user's words" }],
	successConditions: [
		{ description: "Something verifiable that must be true", source: "user", priority: "hard", verificationHint: "What would prove it" },
	],
	forbiddenConditions: [],
	criticalActions: [{ description: "An action to verify before performing", source: "compiler", rationale: "Why", reversible: "no" }],
	ambiguities: [],
	assumptions: [{ description: "Something you filled in that the user did not say", confidence: 0.6 }],
};

export function createTaskCompiler(adapter: ModelAdapter, options: { logger?: Logger; maxRepairAttempts?: number } = {}): TaskCompiler {
	const log = (options.logger ?? nullLogger).child("compiler");

	return {
		async compile(input: CompilerInput): Promise<TaskContract> {
			const started = Date.now();
			const result = await completeStructured<CompiledContract>(adapter, {
				systemPrompt: SYSTEM_PROMPT,
				userPrompt: buildUserPrompt(input),
				schema: CompiledContractSchema,
				example: EXAMPLE_OUTPUT,
				...(input.signal ? { signal: input.signal } : {}),
				...(options.maxRepairAttempts !== undefined ? { maxRepairAttempts: options.maxRepairAttempts } : {}),
				logger: log,
			});

			log.info("contract compiled", {
				model: result.model,
				attempts: result.attempts,
				ms: Date.now() - started,
				requirements: result.value.requirements.length,
				constraints: result.value.constraints.length,
				criticalActions: result.value.criticalActions.length,
			});

			return materialize(result.value, input, result.model);
		},
	};
}

function buildUserPrompt(input: CompilerInput): string {
	const parts: string[] = [
		"Compile this request into a Task Contract.",
		"",
		"<user_request>",
		input.request,
		"</user_request>",
		"",
		"<environment>",
		`working directory: ${input.cwd}`,
		`available tools: ${input.availableTools.length > 0 ? input.availableTools.join(", ") : "(unknown)"}`,
		"</environment>",
	];

	if (input.projectConfig) {
		const p = input.projectConfig;
		parts.push("", "<project_context>");
		if (p.projectType) parts.push(`project type: ${p.projectType}`);
		if (p.preferredCommands) {
			parts.push(`known commands: ${Object.entries(p.preferredCommands).map(([k, v]) => `${k}=${v}`).join(", ")}`);
		}
		if (p.protectedPaths?.length) parts.push(`paths the project marks as protected: ${p.protectedPaths.join(", ")}`);
		if (p.notes) parts.push(`notes: ${p.notes}`);
		parts.push(
			"This is project configuration, not something the user said in this conversation.",
			'Anything derived from it has source "compiler", never "user".',
			"</project_context>",
		);
	}

	if (input.reviewFindings?.length) {
		parts.push(
			"",
			"<review_findings>",
			"An independent reviewer found these problems with your previous attempt. Fix them:",
			...input.reviewFindings.map((f) => `- ${f}`),
			"</review_findings>",
		);
	}

	return parts.join("\n");
}

/**
 * Assign ids, timestamps and defaults.
 *
 * Ids are assigned here rather than by the model so they are stable, predictable
 * (`r1`, `c2`, `s3`) and impossible for a model to collide or reuse across revisions.
 */
function materialize(compiled: CompiledContract, input: CompilerInput, modelId: string): TaskContract {
	const projectConstraints = (input.projectConfig?.protectedPaths ?? []).map((path, i) => ({
		id: `c${compiled.constraints.length + i + 1}`,
		description: `Project configuration marks this path as protected and it must not be modified: ${path}`,
		source: "system" as const,
		priority: "hard" as const,
		check: { kind: "path_unmodified" as const, target: path },
	}));

	return {
		id: newTaskId(),
		version: 1,
		originalRequest: input.request,
		goal: compiled.goal,
		requirements: compiled.requirements.map((r, i) => ({
			id: `r${i + 1}`,
			description: r.description,
			source: r.source,
			priority: r.priority,
			status: "pending" as const,
			...(r.quote ? { quote: r.quote } : {}),
		})),
		constraints: [
			...compiled.constraints.map((c, i) => ({
				id: `c${i + 1}`,
				description: c.description,
				source: c.source,
				priority: c.priority,
				...(c.quote ? { quote: c.quote } : {}),
			})),
			...projectConstraints,
		],
		successConditions: compiled.successConditions.map((s, i) => ({
			id: `s${i + 1}`,
			description: s.description,
			source: s.source,
			priority: s.priority,
			status: "pending" as const,
			...(s.verificationHint ? { verificationHint: s.verificationHint } : {}),
		})),
		forbiddenConditions: compiled.forbiddenConditions.map((f, i) => ({
			id: `f${i + 1}`,
			description: f.description,
			source: f.source,
			priority: f.priority,
		})),
		criticalActions: compiled.criticalActions.map((a, i) => ({
			id: `a${i + 1}`,
			description: a.description,
			source: a.source,
			reversible: a.reversible ?? "unknown",
			requiresVerificationOf: [],
			...(a.rationale ? { rationale: a.rationale } : {}),
		})),
		ambiguities: compiled.ambiguities.map((a, i) => ({
			id: `q${i + 1}`,
			description: a.description,
			blocking: a.blocking ?? false,
			...(a.defaultInterpretation ? { defaultInterpretation: a.defaultInterpretation } : {}),
		})),
		assumptions: compiled.assumptions.map((a, i) => ({
			id: `m${i + 1}`,
			description: a.description,
			confidence: a.confidence ?? 0.5,
		})),
		metadata: {
			createdAt: nowIso(),
			cwd: input.cwd,
			compiledBy: modelId,
			...(compiled.domain ? { domain: compiled.domain } : {}),
		},
	};
}

/**
 * Fallback when the compiler cannot produce a valid contract at all (§limitation 5).
 *
 * Deliberately minimal and honest: it records the request verbatim and claims
 * nothing about it. Gating then relies on generic signals only, and the user is told
 * that contract compilation failed rather than being given a fabricated contract.
 */
export function degradedContract(input: CompilerInput, reason: string): TaskContract {
	return {
		id: newTaskId(),
		version: 1,
		originalRequest: input.request,
		goal: input.request.slice(0, 200),
		requirements: [],
		constraints: [],
		successConditions: [],
		forbiddenConditions: [],
		criticalActions: [],
		ambiguities: [
			{
				id: "q1",
				description: `The Task Compiler could not produce a valid contract (${reason}). The harness is running with generic gating only.`,
				blocking: false,
			},
		],
		assumptions: [],
		metadata: { createdAt: nowIso(), cwd: input.cwd, compiledBy: "degraded", domain: "unknown" },
	};
}

/**
 * The `substantive` auto-compile heuristic (§config contract.autoCompile).
 *
 * Documented rather than hidden, per §68's ban on undocumented heuristics.
 * A prompt is treated as a task when it is long enough to carry obligations, or when
 * it is short but clearly imperative. Pure chatter and meta-questions are skipped so
 * that "what does this file do?" does not spawn a contract and a Judge budget.
 *
 * Wrong in both directions occasionally; `/harness task` and `autoCompile: "always"`
 * are the escape hatches.
 */
export function looksSubstantive(prompt: string, minChars: number): boolean {
	const text = prompt.trim();
	if (text.length === 0) return false;
	if (text.startsWith("/")) return false; // A slash command, not a task.

	// A question with no imperative is almost never a task with obligations.
	const isBareQuestion = /\?\s*$/.test(text) && !/\b(fix|make|create|build|add|remove|run|deploy|prepare|generate|update|write|refactor|migrate|publish|train|clean)\b/i.test(text);
	if (isBareQuestion) return false;

	if (text.length >= minChars) return true;

	// Short but imperative: "deploy to staging", "push the changes".
	return /^(fix|make|create|build|add|remove|delete|run|deploy|prepare|generate|update|write|refactor|migrate|publish|train|clean|implement|install|configure)\b/i.test(text);
}
