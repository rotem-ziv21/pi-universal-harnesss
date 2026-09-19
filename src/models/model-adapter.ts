import { HarnessError } from "../util/errors.ts";

/**
 * The model abstraction (§6).
 *
 * Nothing above this file knows whether the active model is a local Qwen, a
 * llama.cpp build, Claude, GPT, Gemini or something that does not exist yet. The
 * Task Compiler and Contract Reviewer speak only `ModelAdapter`.
 *
 * Swapping the worker model must not require touching harness core logic, so the
 * adapter deliberately exposes the smallest possible surface: one text completion.
 */

export interface ModelRequest {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	/** Propagated from `ctx.signal` so Esc cancels harness model calls too. */
	readonly signal?: AbortSignal;
	readonly maxTokens?: number;
}

export interface ModelResponse {
	readonly text: string;
	readonly model: string;
	readonly usage?: { input?: number; output?: number };
}

export interface ModelAdapter {
	/** Stable identifier for provenance in the event log, e.g. `openai-codex/gpt-5.5`. */
	readonly id: string;
	readonly available: boolean;
	complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Minimal structural view of Pi's model registry.
 *
 * Declared here rather than imported so the harness compiles and unit-tests without
 * Pi present. The real `ExtensionContext` satisfies this shape.
 */
export interface PiModelHost {
	readonly model?: { id: string; provider: string } | undefined;
	readonly modelRegistry?: {
		find(provider: string, modelId: string): unknown;
		hasConfiguredAuth(model: unknown): boolean;
		/**
		 * Pi's own credential lookup. Resolves `/login` credentials and the provider's
		 * environment variable, so the harness never needs its own copy of a key.
		 */
		getApiKeyForProvider?(provider: string): Promise<string | undefined>;
		complete(
			model: unknown,
			context: { systemPrompt?: string; messages: unknown[] },
			options?: Record<string, unknown>,
		): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }>;
	};
}

interface PiUsage {
	input?: number;
	output?: number;
	inputTokens?: number;
	outputTokens?: number;
	input_tokens?: number;
	output_tokens?: number;
}

/**
 * Adapter over whichever model the user currently has selected in Pi.
 *
 * This is what makes `compiler.provider = "current-pi-model"` work: the harness
 * borrows the session's model without ever naming it.
 */
export function createCurrentModelAdapter(host: PiModelHost): ModelAdapter {
	const registry = host.modelRegistry;
	const model = host.model;
	const id = model ? `${model.provider}/${model.id}` : "unknown";
	const available = Boolean(registry && model);

	return {
		id,
		available,
		async complete(request: ModelRequest): Promise<ModelResponse> {
			if (!registry || !model) {
				throw new HarnessError("MODEL_UNAVAILABLE", "No active Pi model is available for harness model calls.");
			}
			if (request.signal?.aborted) {
				throw new HarnessError("ABORTED", "Model call aborted before it started.");
			}

			const response = await registry.complete(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: request.userPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					...(request.signal ? { signal: request.signal } : {}),
					// Harness calls are one-shot and must not pollute the session's prompt cache.
					cacheRetention: "none",
				},
			);

			const text = (response.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!text) {
				throw new HarnessError("MODEL_OUTPUT_UNPARSEABLE", `Model ${id} returned no text content.`, { retryable: true });
			}

			return { text, model: id, usage: normalizeUsage(response.usage) };
		},
	};
}

/**
 * Adapter pinned to a specific `provider/model`, for
 * `compiler.provider = "pinned"` with `compiler.model = "openai/gpt-5-mini"`.
 * Falls back to reporting itself unavailable rather than throwing at construction.
 */
export function createPinnedModelAdapter(host: PiModelHost, provider: string, modelId: string): ModelAdapter {
	const registry = host.modelRegistry;
	const id = `${provider}/${modelId}`;
	const model = registry?.find(provider, modelId);
	const available = Boolean(registry && model && registry.hasConfiguredAuth(model));

	return {
		id,
		available,
		async complete(request: ModelRequest): Promise<ModelResponse> {
			if (!registry || !model) {
				throw new HarnessError("MODEL_UNAVAILABLE", `Model ${id} is not available or has no configured auth.`, {
					details: { model: id },
				});
			}
			return createCurrentModelAdapter({
				model: { id: modelId, provider },
				modelRegistry: { ...registry, find: () => model },
			}).complete(request);
		},
	};
}

/** Deterministic adapter for tests. */
export function createStubModelAdapter(responder: (request: ModelRequest) => string | Promise<string>): ModelAdapter {
	return {
		id: "stub/stub",
		available: true,
		async complete(request) {
			return { text: await responder(request), model: "stub/stub" };
		},
	};
}

function normalizeUsage(usage: unknown): { input?: number; output?: number } | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as PiUsage;
	const input = u.input ?? u.inputTokens ?? u.input_tokens;
	const output = u.output ?? u.outputTokens ?? u.output_tokens;
	if (input === undefined && output === undefined) return undefined;
	return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}
