import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";

/**
 * A generic client for Jev's decisions endpoint, through OpenRouter.
 *
 * Jev is a System One model: it takes a state object and typed questions and returns
 * calibrated probabilities. It writes no prose. That is why it is the only model the
 * harness asks for a decision: whatever the worker model is, the questions and the
 * state here are built by code, so the same facts get the same answer.
 *
 * `ask` never throws. A missing key, a timeout, a bad response: each becomes
 * `{ ok: false }` with a code, and the caller's policy decides what an outage means.
 * One time budget covers every attempt, because a gate that waits past its budget
 * has already failed whatever it was protecting.
 */

export interface NoulQuestion {
	readonly type: "noul";
	readonly instructions: string;
	readonly criteria?: { readonly true: string; readonly false: string };
}

export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions: string;
	readonly criteria: Readonly<Record<string, string>>;
}

export type Question = NoulQuestion | ChoiceQuestion;
export type QuestionSet = Readonly<Record<string, Question>>;

export interface NoulAnswer {
	readonly type: "noul";
	readonly p: number;
}

export interface ChoiceAnswer {
	readonly type: "choice";
	readonly choice: string;
	/** Probability of the chosen option, which is what thresholds apply to. */
	readonly p: number;
	readonly probabilities: Readonly<Record<string, number>>;
}

export type Answer = NoulAnswer | ChoiceAnswer;

export type JevResult =
	| { readonly ok: true; readonly answers: Readonly<Record<string, Answer>>; readonly model: string; readonly latencyMs: number; readonly inputTokens: number }
	| { readonly ok: false; readonly code: JevFailure; readonly message: string; readonly latencyMs: number };

export type JevFailure = "no_key" | "disabled" | "timeout" | "aborted" | "http" | "bad_response";

export interface JevConfig {
	readonly enabled: boolean;
	readonly baseUrl: string;
	readonly decisionsPath: string;
	readonly model: string;
	readonly timeoutMs: number;
}

export interface JevClient {
	ask(state: unknown, questions: QuestionSet, signal?: AbortSignal): Promise<JevResult>;
	readonly model: string;
	stats(): JevStats;
}

export interface JevStats {
	readonly calls: number;
	readonly failures: number;
	readonly totalLatencyMs: number;
	readonly inputTokens: number;
}

export interface JevClientOptions {
	readonly config: JevConfig;
	/** Resolved on every call so a `/login` mid-session takes effect without a reload. */
	readonly getApiKey: () => Promise<string | undefined>;
	readonly logger?: Logger;
	readonly fetchImpl?: typeof fetch;
}

export function createJevClient(options: JevClientOptions): JevClient {
	const { config } = options;
	const log = (options.logger ?? nullLogger).child("jev");
	const doFetch = options.fetchImpl ?? fetch;
	const endpoint = `${config.baseUrl.replace(/\/+$/, "")}${config.decisionsPath}`;
	let stats: JevStats = { calls: 0, failures: 0, totalLatencyMs: 0, inputTokens: 0 };

	const fail = (code: JevFailure, message: string, started: number): JevResult => {
		stats = { ...stats, failures: stats.failures + 1 };
		log.warn("jev request failed", { code, message });
		return { ok: false, code, message, latencyMs: Date.now() - started };
	};

	return {
		model: config.model,
		stats: () => stats,

		async ask(state, questions, signal) {
			const started = Date.now();
			if (!config.enabled) return fail("disabled", "The Judge is disabled in the harness config.", started);

			let apiKey: string | undefined;
			try {
				apiKey = await options.getApiKey();
			} catch {
				apiKey = undefined;
			}
			if (!apiKey) return fail("no_key", "No OpenRouter API key. Run /login in Pi and choose OpenRouter, or set OPENROUTER_API_KEY.", started);

			const body = JSON.stringify({ model: config.model, state, questions });
			const deadline = started + config.timeoutMs;

			// Two attempts at most, both inside the one budget.
			for (let attempt = 0; attempt < 2; attempt++) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				const timeout = new AbortController();
				const timer = setTimeout(() => timeout.abort(), remaining);
				const combined = signal ? anySignal([signal, timeout.signal]) : timeout.signal;
				try {
					const response = await doFetch(endpoint, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json",
							"HTTP-Referer": "https://github.com/pi-universal-harness",
							"X-Title": "Pi Universal Harness",
						},
						body,
						signal: combined,
					});
					if (!response.ok) {
						const text = await response.text().catch(() => "");
						// Retry only what a retry can fix.
						if ((response.status === 429 || response.status >= 500) && attempt === 0) continue;
						return fail("http", `HTTP ${response.status} from ${endpoint}: ${text.slice(0, 200)}`, started);
					}
					const parsed = (await response.json()) as { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
					const answers = readAnswers(parsed?.answers, questions);
					if (!answers) {
						if (attempt === 0) continue;
						return fail("bad_response", "The decisions endpoint returned missing or malformed answers.", started);
					}
					const latencyMs = Date.now() - started;
					const inputTokens = parsed.usage?.input_tokens ?? 0;
					stats = {
						calls: stats.calls + 1,
						failures: stats.failures,
						totalLatencyMs: stats.totalLatencyMs + latencyMs,
						inputTokens: stats.inputTokens + inputTokens,
					};
					return { ok: true, answers, model: parsed.model ?? config.model, latencyMs, inputTokens };
				} catch (e) {
					if (signal?.aborted) return fail("aborted", "Aborted by the user.", started);
					if (timeout.signal.aborted) return fail("timeout", `No answer within ${config.timeoutMs}ms.`, started);
					if (attempt === 0) continue;
					return fail("http", `Request to ${endpoint} failed: ${e instanceof Error ? e.message : String(e)}`, started);
				} finally {
					clearTimeout(timer);
				}
			}
			return fail("timeout", `No answer within ${config.timeoutMs}ms.`, started);
		},
	};
}

/** Every asked question must come back in the shape it was asked, or the whole answer is unusable. */
function readAnswers(raw: Record<string, unknown> | undefined, questions: QuestionSet): Record<string, Answer> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, Answer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = raw[id] as Record<string, unknown> | undefined;
		if (!answer || typeof answer !== "object") return undefined;
		if (question.type === "noul") {
			const p = answer.noul;
			if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
			out[id] = { type: "noul", p: clamp01(p) };
			continue;
		}
		const choice = answer.choice;
		const probabilities = answer.probabilities as Record<string, number> | undefined;
		if (typeof choice !== "string" || !(choice in question.criteria)) return undefined;
		const p = probabilities && typeof probabilities[choice] === "number" ? clamp01(probabilities[choice]) : undefined;
		if (p === undefined) return undefined;
		out[id] = { type: "choice", choice, p, probabilities: probabilities ?? {} };
	}
	return out;
}

export function noul(answers: Readonly<Record<string, Answer>>, id: string): number {
	const answer = answers[id];
	return answer?.type === "noul" ? answer.p : 0;
}

export function choice(answers: Readonly<Record<string, Answer>>, id: string): ChoiceAnswer | undefined {
	const answer = answers[id];
	return answer?.type === "choice" ? answer : undefined;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function anySignal(signals: AbortSignal[]): AbortSignal {
	const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyOf === "function") return anyOf(signals);
	const controller = new AbortController();
	for (const s of signals) {
		if (s.aborted) controller.abort();
		s.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}
