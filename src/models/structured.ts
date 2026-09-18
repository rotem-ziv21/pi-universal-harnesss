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
	readonly logger?: Logger;
}

export interface StructuredResult<T> {
	readonly value: T;
	readonly attempts: number;
	readonly model: string;
	readonly usage?: { input?: number; output?: number };
}

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

	let userPrompt = request.userPrompt;
	let lastError = "";
	let totalUsage: { input?: number; output?: number } | undefined;

	for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
		if (request.signal?.aborted) throw new HarnessError("ABORTED", "Structured model call aborted.");

		const modelRequest: ModelRequest = {
			systemPrompt,
			userPrompt,
			...(request.signal ? { signal: request.signal } : {}),
		};
		const response = await adapter.complete(modelRequest);
		totalUsage = mergeUsage(totalUsage, response.usage);

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
