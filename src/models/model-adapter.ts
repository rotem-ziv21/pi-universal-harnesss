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
		/** Every model Pi can currently reach, for the `/harness model` picker. */
		getAvailable?(): Array<{ id: string; provider: string }>;
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
	const model = host.model;
	return createAdapter({
		registry: host.modelRegistry,
		model,
		id: model ? `${model.provider}/${model.id}` : "unknown",
		available: Boolean(host.modelRegistry && model),
		unavailableMessage: "No active Pi model is available for harness model calls.",
	});
}

/**
 * The single implementation both adapters share.
 *
 * `registry` and `model` are passed through untouched. An earlier version built the
 * pinned adapter by spreading the registry (`{...registry, find: () => model}`) to
 * swap the lookup — which silently produced an object with no `complete` method,
 * because Pi's ModelRegistry is a class and spread copies only own properties, not
 * the prototype. Pinning any model threw "registry.complete is not a function" on the
 * first call. Passing the model alongside the registry avoids the whole problem.
 */
function createAdapter(args: {
	registry: PiModelHost["modelRegistry"];
	model: unknown;
	id: string;
	available: boolean;
	unavailableMessage: string;
}): ModelAdapter {
	const { registry, model, id } = args;

	return {
		id,
		available: args.available,
		async complete(request: ModelRequest): Promise<ModelResponse> {
			if (!registry || !model) {
				throw new HarnessError("MODEL_UNAVAILABLE", args.unavailableMessage, { details: { model: id } });
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
 * Adapter pinned to a specific `provider/model`, so the compiler or reviewer can use
 * a model other than the one the session happens to be on — a cheap local model, or a
 * deliberately different one for the reviewer so it does not share the compiler's
 * blind spots.
 *
 * Reports itself unavailable rather than throwing at construction, so a typo in the
 * config surfaces in `/harness status` instead of breaking startup.
 */
export function createPinnedModelAdapter(host: PiModelHost, provider: string, modelId: string): ModelAdapter {
	const registry = host.modelRegistry;
	const model = registry?.find(provider, modelId);

	/**
	 * `hasConfiguredAuth` is a *reporting* signal, not a gate. A locally served model
	 * needs no credential, and refusing to run one because Pi lists no auth for it
	 * would break exactly the local-model case this exists to support.
	 */
	const available = Boolean(registry && model && (registry.hasConfiguredAuth(model) || isLocal(registry, provider)));

	return createAdapter({
		registry,
		model,
		id: `${provider}/${modelId}`,
		available,
		unavailableMessage: `Model ${provider}/${modelId} was not found in Pi's registry. Check the provider and model ids with /model.`,
	});
}

/** A provider served from the loopback interface needs no API key. */
function isLocal(registry: NonNullable<PiModelHost["modelRegistry"]>, provider: string): boolean {
	try {
		const base = (registry as { getProvider?(id: string): { baseUrl?: string } | undefined }).getProvider?.(provider)?.baseUrl;
		return typeof base === "string" && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(base);
	} catch {
		return false;
	}
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
