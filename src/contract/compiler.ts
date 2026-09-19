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
	/** Progress callback so the UI can show which attempt is running. */
	readonly onAttempt?: ((attempt: number, total: number) => void) | undefined;
}

export interface TaskCompiler {
	compile(input: CompilerInput): Promise<TaskContract>;
}

const SYSTEM_PROMPT = `You compile a user's request into a structured Task Contract for a domain-agnostic execution harness.

The contract separates human intent from executable verification:
- Descriptions are prose. The harness NEVER parses them into commands or policy.
- "verification" contains typed strategies. Use command_execution only when the exact
  program and argument vector are explicitly known from the user or project context.
- For qualitative claims use semantic_evaluation or visual_evaluation. For direct
  resource facts use resource_state. For action-history invariants use
  event_log_assertion. Use user_confirmation only when the user must decide.
- Do not invent a command from phrases such as "run a comparison" or "verify visually".

SOURCE AND PRIORITY
- source "user": stated by the user; preserve their words in quote.
- source "compiler": inferred best practice. Never label an inference as user.
- priority "hard": cannot be traded away. Explicit user requirements and prohibitions
  are hard. Compiler-derived preferences are normally soft.

ITEM TYPES
- requirement: something to achieve.
- constraint: a boundary on execution. When it maps to action semantics, add policy
  with effect forbid or require_review and an action selector.
- successCondition: something demonstrably true at completion, with typed verification
  whenever the environment exposes a real way to verify it.
- forbiddenCondition: an outcome that must never occur. Add a typed forbid policy only
  when action semantics can directly represent it.
- criticalAction: an action to verify before execution. Add an action selector using
  task-independent capabilities, resource operations, provenance, scope, kind, or
  externalSideEffect. Never encode a concrete tool name in policy.
- ambiguity: unresolved meaning, blocking only when proceeding could cause harm.
- assumption: compiler-filled context, never a user instruction.

ACTION CAPABILITIES
read_resource, create_resource, modify_resource, delete_resource, move_resource,
query_resource, execute_code, install_dependency, commit, mutate_remote, publish,
deploy, generate_artifact.

RESOURCE DIMENSIONS
- operation: read, create, modify, delete, move, execute, query, publish, deploy.
- provenance: preexisting, created_by_current_task, created_by_harness, external, unknown.
- scope: allowed, protected, outside_allowed, external, unknown.
- kind: file, directory, vcs_ref, api_object, database_record, deployment, artifact,
  remote_resource, unknown.

VERIFICATION STRATEGIES
- command_execution: {program, args, cwd?, expectExitCode, stdout?, stderr?}. Program
  and args are separate; no shell strings.
- resource_state: {resource, condition: exists|absent|hash_equals, expectedHash?}.
- event_log_assertion: {action, operator: equals|at_least|at_most|none, count}.
- semantic_evaluation: {instructions, evidenceSources}.
- visual_evaluation: {instructions, resources}.
- user_confirmation: {prompt}.

RULES
- Be faithful, not exhaustive. Do not pad with generic best practices.
- A numeric limit from the user is hard.
- Empty arrays are correct for trivial requests.
- A strategy must be executable with available tools or explicitly identify the
  qualitative evaluator. If no real verification route is known, omit it rather than
  disguise prose as an executable check.

EXAMPLES
1. A local source file must remain untouched:
   constraint.policy = {effect:"forbid", action:{capabilities:["modify_resource"],
   provenances:["preexisting"], targetUriPrefix:"file:///known/source"}}
2. Publishing any artifact needs review:
   criticalAction.action = {capabilities:["publish"], externalSideEffect:true}
3. A generated poster needs qualitative inspection:
   successCondition.verification = [{kind:"visual_evaluation",
   instructions:"Compare the rendered poster with the requested composition",
   resources:["output/poster.png"]}]
4. A protected input collection must never be changed:
   constraint.policy = {effect:"forbid", action:{operations:["modify","delete"],
   scopes:["protected"]}}
5. An exact verifier is known from project context:
   successCondition.verification = [{kind:"command_execution", program:"python3",
   args:["tools/verify.py","output.bin"], expectExitCode:0}]`;

const EXAMPLE_OUTPUT: CompiledContract = {
	goal: "Produce the requested artifact without mutating protected inputs",
	domain: "artifact generation",
	workspace: { allowedScopes: [], protectedResources: ["inputs/source"] },
	requirements: [
		{
			description: "The requested artifact exists",
			source: "user",
			priority: "hard",
			quote: "produce the artifact",
			verification: [{ kind: "resource_state", resource: "output/artifact.bin", condition: "exists" }],
		},
	],
	constraints: [
		{
			description: "Protected inputs remain unchanged",
			source: "user",
			priority: "hard",
			quote: "do not modify the inputs",
			policy: {
				effect: "forbid",
				action: { operations: ["modify", "delete"], scopes: ["protected"] },
			},
		},
	],
	successConditions: [],
	forbiddenConditions: [],
	criticalActions: [
		{
			description: "Publish an artifact outside the workspace",
			source: "compiler",
			rationale: "Externally visible and difficult to reverse",
			reversible: "no",
			action: { capabilities: ["publish"], externalSideEffect: true },
		},
	],
	ambiguities: [],
	assumptions: [],
};

export function createTaskCompiler(adapter: ModelAdapter, options: { logger?: Logger; maxRepairAttempts?: number; timeoutMs?: number } = {}): TaskCompiler {
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
				...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
				...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
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
	const allowedScopes = compiled.workspace?.allowedScopes.length ? compiled.workspace.allowedScopes : [input.cwd];
	const protectedResources = [
		...new Set([...(compiled.workspace?.protectedResources ?? []), ...(input.projectConfig?.protectedPaths ?? [])]),
	];
	return {
		id: newTaskId(),
		version: 1,
		originalRequest: input.request,
		goal: compiled.goal,
		workspace: { allowedScopes, protectedResources },
		requirements: compiled.requirements.map((requirement, index) => ({
			id: `r${index + 1}`,
			description: requirement.description,
			source: requirement.source,
			priority: requirement.priority,
			status: "pending" as const,
			...(requirement.quote ? { quote: requirement.quote } : {}),
			...(requirement.verification ? { verification: requirement.verification } : {}),
		})),
		constraints: compiled.constraints.map((constraint, index) => ({
			id: `c${index + 1}`,
			description: constraint.description,
			source: constraint.source,
			priority: constraint.priority,
			...(constraint.quote ? { quote: constraint.quote } : {}),
			...(constraint.policy ? { policy: constraint.policy } : {}),
			...(constraint.verification ? { verification: constraint.verification } : {}),
		})),
		successConditions: compiled.successConditions.map((condition, index) => ({
			id: `s${index + 1}`,
			description: condition.description,
			source: condition.source,
			priority: condition.priority,
			status: "pending" as const,
			...(condition.verification ? { verification: condition.verification } : {}),
		})),
		forbiddenConditions: compiled.forbiddenConditions.map((condition, index) => ({
			id: `f${index + 1}`,
			description: condition.description,
			source: condition.source,
			priority: condition.priority,
			...(condition.policy ? { policy: condition.policy } : {}),
			...(condition.verification ? { verification: condition.verification } : {}),
		})),
		criticalActions: compiled.criticalActions.map((critical, index) => ({
			id: `a${index + 1}`,
			description: critical.description,
			source: critical.source,
			reversible: critical.reversible ?? "unknown",
			requiresVerificationOf: [],
			...(critical.rationale ? { rationale: critical.rationale } : {}),
			...(critical.action ? { action: critical.action } : {}),
		})),
		ambiguities: compiled.ambiguities.map((ambiguity, index) => ({
			id: `q${index + 1}`,
			description: ambiguity.description,
			blocking: ambiguity.blocking ?? false,
			...(ambiguity.defaultInterpretation ? { defaultInterpretation: ambiguity.defaultInterpretation } : {}),
		})),
		assumptions: compiled.assumptions.map((assumption, index) => ({
			id: `m${index + 1}`,
			description: assumption.description,
			confidence: assumption.confidence ?? 0.5,
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
