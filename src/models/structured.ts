import type { TSchema } from "typebox";
import { HarnessError } from "../util/errors.ts";
import { clamp, extractJson } from "../util/json.ts";
import type { Logger } from "../util/logger.ts";
import { formatIssues, withDefaults } from "../util/validate.ts";
import type { ModelAdapter, ModelRequest } from "./model-adapter.ts";

/**
 * Schema-validated structured output from an arbitrary model (§12).
 *
 * Provider-native JSON-schema modes are *not* used here. They are not uniformly
 * available across local Qwen, Kimi, llama.cpp, Claude, GPT and Gemini, and relying
 * on one would quietly break the model-agnostic promise. Instead:
 *
 *   constrain by prompt → extract → validate → repair (bounded) → give up loudly
 *
 * The repair loop is bounded because an unbounded one burns tokens on a model that
 * simply cannot produce the shape, and hides the failure from the user.
 */

export interface StructuredRequest {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly schema: TSchema;
	/** Hand-written example of a valid document. Worth far more than schema prose to small models. */
	readonly example?: unknown;
	readonly signal?: AbortSignal;
	readonly maxRepairAttempts?: number;
	/** Per-attempt budget. Exceeding it aborts that attempt, not the whole call. */
	readonly timeoutMs?: number;
	/** Called before each attempt so the UI can say what is happening and for how long. */
	readonly onAttempt?: (attempt: number, totalAttempts: number) => void;
	readonly logger?: Logger;
}

export interface StructuredResult<T> {
	readonly value: T;
	readonly attempts: number;
	readonly model: string;
	readonly usage?: { input?: number; output?: number };
}

/** Generous: a large local model on modest hardware is slow, not broken. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Output budget for the retry after an empty reply: room for the document with thinking off. */
const EMPTY_REPLY_RETRY_MAX_TOKENS = 32_000;

const JSON_DISCIPLINE = [
	"OUTPUT FORMAT — this is not negotiable:",
	"- Reply with exactly one JSON document and nothing else.",
	"- No prose before it, no prose after it, no explanation, no apology.",
	"- Do not wrap it in markdown fences.",
	"- Use only the fields defined by the schema. Do not invent fields.",
	"- If you are unsure about a value, use the schema's default or omit the optional field.",
].join("\n");

export async function completeStructured<T>(adapter: ModelAdapter, request: StructuredRequest): Promise<StructuredResult<T>> {
	const maxRepairs = request.maxRepairAttempts ?? 2;
	const log = request.logger;

	const systemPrompt = [
		request.systemPrompt,
		"",
		JSON_DISCIPLINE,
		"",
		"JSON Schema the document must satisfy:",
		JSON.stringify(request.schema),
		...(request.example !== undefined ? ["", "A valid example:", JSON.stringify(request.example, null, 2)] : []),
	].join("\n");

	log?.debug("structured output: request", {
		model: adapter.id,
		systemPromptChars: systemPrompt.length,
		userPromptChars: request.userPrompt.length,
		userPrompt: clamp(request.userPrompt, 2000),
	});

	let userPrompt = request.userPrompt;
	let lastError = "";
	let override: Pick<ModelRequest, "reasoning" | "maxTokens"> | undefined;
	let totalUsage: { input?: number; output?: number } | undefined;

	const totalAttempts = maxRepairs + 1;

	for (let attempt = 1; attempt <= totalAttempts; attempt++) {
		if (request.signal?.aborted) throw new HarnessError("ABORTED", "Structured model call aborted.");
		request.onAttempt?.(attempt, totalAttempts);

		/**
		 * The timeout is per attempt and is combined with the caller's signal, so Esc
		 * still cancels immediately while a stalled model cannot hold the session open
		 * forever.
		 */
		const attemptStarted = Date.now();
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		let response: Awaited<ReturnType<typeof adapter.complete>>;
		try {
			const modelRequest: ModelRequest = {
				systemPrompt,
				userPrompt,
				signal: combineSignals(request.signal, timeout.signal),
				...(override ?? {}),
			};
			response = await adapter.complete(modelRequest);
		} catch (e) {
			if (request.signal?.aborted) throw new HarnessError("ABORTED", "Structured model call aborted.");
			/**
			 * No text came back. With a reasoning model this almost always means the
			 * thinking ate the output budget (GLM did exactly that: 8k tokens of
			 * deliberation, zero tokens of JSON, three compilations in a row). That is a
			 * request-shape problem, not a model problem, so the next attempt turns
			 * thinking off and gives the answer room. Only then is the failure real.
			 */
			if (e instanceof HarnessError && e.code === "MODEL_OUTPUT_UNPARSEABLE" && attempt < totalAttempts) {
				lastError = e.message;
				override = { reasoning: "off", maxTokens: EMPTY_REPLY_RETRY_MAX_TOKENS };
				log?.warn("structured output: empty reply; retrying with thinking off", { attempt, model: adapter.id, error: e.message });
				continue;
			}
			if (timeout.signal.aborted) {
				const seconds = Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
				throw new HarnessError(
					"MODEL_UNAVAILABLE",
					`Model ${adapter.id} did not respond within ${seconds}s. ` +
						"If it is a local model, check the server is running and is not still loading weights. " +
						"Raise the budget with the timeoutMs setting, or point this role at a different model with /harness model.",
					{ details: { model: adapter.id, timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS }, cause: e },
				);
			}
			throw e;
		} finally {
			clearTimeout(timer);
		}

		totalUsage = mergeUsage(totalUsage, response.usage);

		/**
		 * At debug level, record what the model actually said.
		 *
		 * Pi's extension API returns a completed message rather than a token stream, and
		 * Pi's TUI only renders its own agent loop — so a nested harness call is invisible
		 * while it runs. The log is the only window into what a compiler or reviewer
		 * model produced, which matters most precisely when the output is disappointing.
		 */
		log?.debug("structured output: raw response", {
			attempt,
			model: response.model,
			ms: Date.now() - attemptStarted,
			chars: response.text.length,
			...(response.usage ? { usage: response.usage } : {}),
			text: clamp(response.text, 4000),
		});

		const extracted = extractJson<unknown>(response.text);
		if (!extracted.ok) {
			lastError = extracted.error;
			log?.warn("structured output: no JSON found", { attempt, model: adapter.id, error: extracted.error });
			userPrompt = repairPrompt(request.userPrompt, response.text, `Your reply contained no parseable JSON. ${extracted.error}`);
			continue;
		}

		const validated = withDefaults<T>(request.schema, extracted.value);
		if (validated.ok) {
			return {
				value: validated.value,
				attempts: attempt,
				model: response.model,
				...(totalUsage ? { usage: totalUsage } : {}),
			};
		}

		lastError = formatIssues(validated.issues);
		log?.warn("structured output: schema violation", { attempt, model: adapter.id, issues: validated.issues });
		userPrompt = repairPrompt(
			request.userPrompt,
			JSON.stringify(extracted.value),
			`Your JSON did not satisfy the schema. Fix exactly these problems and return the corrected document:\n${lastError}`,
		);
	}

	throw new HarnessError("MODEL_OUTPUT_INVALID", `Model ${adapter.id} could not produce a valid document after ${maxRepairs + 1} attempts: ${lastError}`, {
		details: { model: adapter.id, attempts: maxRepairs + 1, lastError },
	});
}

/**
 * Repair prompts restate the original task.
 *
 * Sending only the error makes weaker models "fix" the JSON by inventing content
 * unrelated to the request — which, for a Task Contract, means fabricating user
 * requirements. The original request has to stay in view.
 */
function repairPrompt(original: string, previousOutput: string, problem: string): string {
	return [
		original,
		"",
		"--- CORRECTION REQUIRED ---",
		problem,
		"",
		"Your previous reply was:",
		clamp(previousOutput, 2000),
		"",
		"Return the corrected JSON document only. Keep the content faithful to the original request above; do not invent new content to satisfy the schema.",
	].join("\n");
}

function mergeUsage(
	a: { input?: number; output?: number } | undefined,
	b: { input?: number; output?: number } | undefined,
): { input?: number; output?: number } | undefined {
	if (!a) return b;
	if (!b) return a;
	return { input: (a.input ?? 0) + (b.input ?? 0), output: (a.output ?? 0) + (b.output ?? 0) };
}

/** `AbortSignal.any` where available, with a manual fallback for older runtimes. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyOf === "function") return anyOf([a, b]);

	const controller = new AbortController();
	const forward = () => controller.abort();
	if (a.aborted || b.aborted) controller.abort();
	a.addEventListener("abort", forward, { once: true });
	b.addEventListener("abort", forward, { once: true });
	return controller.signal;
}
