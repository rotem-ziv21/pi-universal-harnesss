import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { VerificationStrategy } from "../contract/schema.ts";
import { matchesActionSelector } from "../checkpoints/signals.ts";
import type { ModelAdapter } from "../models/model-adapter.ts";
import { redact } from "../security/redact.ts";
import { resourceUri } from "../resources/registry.ts";
import type { HarnessState } from "../state/types.ts";
import { clamp } from "../util/json.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { CollectedEvidence, CollectionResult, EvidencePlan, EvidenceRequest } from "./types.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export type ExecFn = (command: string, args: string[], options: { signal?: AbortSignal; cwd?: string }) => Promise<ExecResult>;

export interface EvidenceCollector {
	collect(args: {
		plan: EvidencePlan;
		cwd: string;
		state: HarnessState;
		signal?: AbortSignal | undefined;
	}): Promise<CollectionResult>;
}

export interface CollectorOptions {
	readonly exec?: ExecFn | undefined;
	readonly reviewer?: ModelAdapter | undefined;
	readonly confirm?: ((prompt: string) => Promise<boolean>) | undefined;
	readonly logger?: Logger;
	readonly commandTimeoutMs?: number;
	readonly maxOutputChars?: number;
}

interface CollectionContext {
	cwd: string;
	state: HarnessState;
	signal: AbortSignal | undefined;
	options: CollectorOptions;
	maxOutput: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 4_000;

export function createEvidenceCollector(options: CollectorOptions = {}): EvidenceCollector {
	const log = (options.logger ?? nullLogger).child("evidence:collect");
	const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
	return {
		async collect({ plan, cwd, state, signal }): Promise<CollectionResult> {
			const started = Date.now();
			const collected: CollectedEvidence[] = [];
			const failed: Array<{ requestId: string; reason: string }> = [];
			for (const request of plan.evidenceRequests) {
				if (signal?.aborted) {
					failed.push({ requestId: request.id, reason: "aborted" });
					continue;
				}
				try {
					collected.push(await collectOne(request, { cwd, state, signal, options, maxOutput }));
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					log.warn("evidence collection failed", { request: request.id, kind: request.strategy.kind, reason });
					failed.push({ requestId: request.id, reason });
				}
			}
			const durationMs = Date.now() - started;
			log.info("evidence collected", { requests: plan.evidenceRequests.length, ok: collected.length, failed: failed.length, durationMs });
			return { collected, failed, durationMs };
		},
	};
}

async function collectOne(request: EvidenceRequest, context: CollectionContext): Promise<CollectedEvidence> {
	switch (request.strategy.kind) {
		case "command_execution":
			return collectCommand(request, request.strategy, context);
		case "resource_state":
			return collectResourceState(request, request.strategy, context);
		case "event_log_assertion":
			return collectEventLog(request, request.strategy, context);
		case "semantic_evaluation":
		case "visual_evaluation":
			return collectReviewer(request, request.strategy, context);
		case "user_confirmation":
			return collectUserConfirmation(request, request.strategy, context);
	}
}

async function collectCommand(
	request: EvidenceRequest,
	declared: Extract<VerificationStrategy, { kind: "command_execution" }>,
	context: CollectionContext,
): Promise<CollectedEvidence> {
	let strategy = declared;
	if (!context.options.exec) throw new Error("no exec function is available to run an explicit verification command");
	/**
	 * Compilers regularly emit `{program: "npm test", args: []}`. That is still an
	 * argv — whitespace-split, no shell — so accept it rather than throw away the one
	 * typed check the contract has. A program with shell syntax is still refused.
	 */
	if (strategy.args.length === 0 && /\s/.test(strategy.program.trim())) {
		const [program, ...args] = strategy.program.trim().split(/\s+/);
		strategy = { ...strategy, program: program!, args };
	}
	if (!/^[a-z0-9_./-]+$/i.test(strategy.program)) throw new Error(`invalid verification program: ${strategy.program}`);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), context.options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const commandCwd = strategy.cwd
			? isAbsolute(strategy.cwd)
				? strategy.cwd
				: resolve(context.cwd, strategy.cwd)
			: context.cwd;
		const result = await context.options.exec(strategy.program, [...strategy.args], {
			cwd: commandCwd,
			...(context.signal ? { signal: anySignal(context.signal, timeout.signal) } : { signal: timeout.signal }),
		});
		const exitCode = result.exitCode ?? -1;
		const stdout = result.stdout.trim();
		const stderr = result.stderr.trim();
		const stdoutMatch = strategy.stdout ? compareOutput(stdout, strategy.stdout) : true;
		const stderrMatch = strategy.stderr ? compareOutput(stderr, strategy.stderr) : true;
		const supported = exitCode === strategy.expectExitCode && stdoutMatch && stderrMatch;
		const output = redact(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim());
		const expected = { exitCode: strategy.expectExitCode, stdout: strategy.stdout, stderr: strategy.stderr };
		const observed = { exitCode, stdout: clamp(stdout, context.maxOutput), stderr: clamp(stderr, context.maxOutput) };
		return baseEvidence(request, {
			summary: supported
				? `Explicit command verification matched: ${strategy.program} exited ${exitCode}.`
				: `Explicit command verification mismatch: ${strategy.program} exited ${exitCode}; output ${clamp(output || "(none)", 240)}.`,
			result: supported ? "supported" : "contradicted",
			observed,
			expected,
			value: { program: strategy.program, args: strategy.args, cwd: commandCwd, observed, expected },
			sourceType: "command",
			source: `${strategy.program} ${strategy.args.join(" ")}`.trim(),
			provenance: "explicit_contract_strategy",
			trust: "runtime_evidence",
			...(supported ? {} : { error: "command result did not match its typed expectation" }),
		});
	} finally {
		clearTimeout(timer);
	}
}

function collectResourceState(
	request: EvidenceRequest,
	strategy: Extract<VerificationStrategy, { kind: "resource_state" }>,
	context: CollectionContext,
): CollectedEvidence {
	const path = isAbsolute(strategy.resource) ? strategy.resource : resolve(context.cwd, strategy.resource);
	let exists = false;
	let size: number | undefined;
	let hash: string | undefined;
	let modifiedAt: string | undefined;
	try {
		const stats = statSync(path);
		exists = true;
		size = stats.size;
		modifiedAt = stats.mtime.toISOString();
		if (stats.isFile()) hash = createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		// Absence is an observation, not a collection error.
	}
	const supported =
		strategy.condition === "exists"
			? exists
			: strategy.condition === "absent"
				? !exists
				: exists && typeof strategy.expectedHash === "string" && hash === strategy.expectedHash;
	const observed = { path, exists, ...(size === undefined ? {} : { size }), ...(hash ? { hash } : {}), ...(modifiedAt ? { modifiedAt } : {}) };
	const expected = { condition: strategy.condition, ...(strategy.expectedHash ? { hash: strategy.expectedHash } : {}) };
	return baseEvidence(request, {
		summary: `${strategy.resource}: observed ${exists ? "present" : "absent"}; expected ${strategy.condition}${supported ? " (match)" : " (MISMATCH)"}.`,
		result: supported ? "supported" : "contradicted",
		observed,
		expected,
		value: { observed, expected },
		sourceType: "file",
		source: path,
		provenance: "direct_resource_observation",
		trust: "runtime_evidence",
		validity: resourceUri(strategy.resource, context.cwd),
		...(supported ? {} : { error: "resource state did not match its typed expectation" }),
	});
}

function collectEventLog(
	request: EvidenceRequest,
	strategy: Extract<VerificationStrategy, { kind: "event_log_assertion" }>,
	context: CollectionContext,
): CollectedEvidence {
	const matching = context.state.actions.filter(
		(action) => action.outcome === "succeeded" && matchesActionSelector(strategy.action, { ...action, input: {}, summary: action.summary }),
	);
	const count = matching.length;
	const supported =
		strategy.operator === "none"
			? count === 0
			: strategy.operator === "equals"
				? count === strategy.count
				: strategy.operator === "at_least"
					? count >= strategy.count
					: count <= strategy.count;
	return baseEvidence(request, {
		summary: `Event-log assertion observed ${count} matching successful action(s); expected ${strategy.operator} ${strategy.count}.`,
		result: supported ? "supported" : "contradicted",
		observed: { count, actionIds: matching.map((action) => action.id) },
		expected: { operator: strategy.operator, count: strategy.count },
		value: { count, actionIds: matching.map((action) => action.id) },
		sourceType: "harness",
		source: "task event log",
		provenance: "canonical_state",
		trust: "runtime_evidence",
		...(supported ? {} : { error: "event-log count did not match its typed expectation" }),
	});
}

async function collectReviewer(
	request: EvidenceRequest,
	strategy: Extract<VerificationStrategy, { kind: "semantic_evaluation" | "visual_evaluation" }>,
	context: CollectionContext,
): Promise<CollectedEvidence> {
	const reviewer = context.options.reviewer;
	if (!reviewer?.available) throw new Error(`no reviewer is available for ${strategy.kind}`);
	const instructions = strategy.instructions;
	const sources = strategy.kind === "visual_evaluation" ? strategy.resources : strategy.evidenceSources;

	/**
	 * The reviewer is given what the sources actually contain, not just their names.
	 * Handed "Evidence sources: out/" alone, a model can only answer CANNOT_DETERMINE,
	 * and did — which made every semantic strategy a dead route. The harness reads
	 * the named files and directories itself (runtime observation, redacted, capped)
	 * and adds the worker's recent tool results, so the reviewer judges real content.
	 */
	const observed = await Promise.all(sources.map(async (source) => ({ source, content: await observeSource(source, context) })));
	const recentResults = context.state.actions
		.filter((a) => (a.outcome === "succeeded" || a.outcome === "failed") && a.resultSummary)
		.slice(-8)
		.map((a) => `- ${clamp(a.summary, 160)} → ${a.outcome}: ${clamp(a.resultSummary ?? "", 300)}`);

	const response = await reviewer.complete({
		systemPrompt:
			"You are an evidence reviewer. Assess only the observed resource contents and tool results supplied below. " +
			"Begin your reply with exactly one of VERIFIED, NOT_VERIFIED, or CANNOT_DETERMINE, then one short sentence of justification. " +
			"Do not infer anything that the supplied content does not show.",
		userPrompt: [
			`Verification instructions: ${instructions}`,
			"",
			...observed.flatMap(({ source, content }) => [`<source path="${source}">`, content, "</source>", ""]),
			...(recentResults.length > 0 ? ["Recent tool results (from the runtime, not the agent):", ...recentResults] : []),
		].join("\n"),
		...(context.signal ? { signal: context.signal } : {}),
	});
	const text = response.text.trim();
	const result = /^VERIFIED\b/i.test(text) ? "supported" : /^NOT_VERIFIED\b/i.test(text) ? "contradicted" : "unknown";
	return baseEvidence(request, {
		summary: clamp(text, 400),
		result,
		observed: { response: text, sources },
		expected: instructions,
		value: { response: text, model: response.model, sources },
		sourceType: "model",
		source: `reviewer:${response.model}`,
		provenance: "model_interpretation_of_named_sources",
		trust: "model_interpretation",
		...(result === "supported" ? {} : { error: "reviewer did not verify the condition" }),
	});
}

async function collectUserConfirmation(
	request: EvidenceRequest,
	strategy: Extract<VerificationStrategy, { kind: "user_confirmation" }>,
	context: CollectionContext,
): Promise<CollectedEvidence> {
	if (!context.options.confirm) throw new Error("no interactive confirmation channel is available");
	const confirmed = await context.options.confirm(strategy.prompt);
	return baseEvidence(request, {
		summary: confirmed ? "User confirmed the typed completion condition." : "User declined the typed completion condition.",
		result: confirmed ? "supported" : "contradicted",
		observed: confirmed,
		expected: true,
		value: { confirmed, prompt: strategy.prompt },
		sourceType: "user",
		source: "interactive confirmation",
		provenance: "explicit_user_response",
		trust: "user_instruction",
		...(confirmed ? {} : { error: "user did not confirm" }),
	});
}

function baseEvidence(
	request: EvidenceRequest,
	fields: Omit<CollectedEvidence, "requestId" | "requirementIds" | "type" | "freshnessClass">,
): CollectedEvidence {
	return {
		requestId: request.id,
		requirementIds: request.requirementIds,
		type: request.strategy.kind,
		freshnessClass: request.freshnessClass,
		...fields,
	};
}

/** What a named source currently contains: file text, a directory listing, a fetched page, or its absence. */
async function observeSource(source: string, context: CollectionContext): Promise<string> {
	if (/^https?:\/\//i.test(source)) return fetchSource(source, context);
	const path = isAbsolute(source) ? source : resolve(context.cwd, source);
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) {
			return `(directory) entries: ${readdirSync(path).sort().join(", ") || "(empty)"}`;
		}
		if (!stats.isFile()) return `(exists, not a regular file, ${stats.size} bytes)`;
		const buffer = readFileSync(path);
		if (buffer.subarray(0, 512).includes(0)) return `(binary file, ${stats.size} bytes, sha256 ${createHash("sha256").update(buffer).digest("hex")})`;
		return redact(clamp(buffer.toString("utf8"), context.maxOutput));
	} catch {
		return "(does not exist)";
	}
}

/**
 * A read-only GET of a named remote source, so a semantic strategy over web
 * content is judged on the content. Bounded in time and size; failure is reported
 * as an observation ("HTTP 403"), never guessed around.
 */
async function fetchSource(url: string, context: CollectionContext): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: context.signal ? anySignal(context.signal, controller.signal) : controller.signal,
			redirect: "follow",
			headers: {
				// Sites that serve full content to browsers and a login wall to everything
				// else (LinkedIn) must show the reviewer what the worker saw.
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
				accept: "text/html,application/xhtml+xml,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
			},
		});
		const body = (await response.text()).slice(0, FETCH_MAX_CHARS);
		const text = /<html/i.test(body) ? htmlToText(body) : body;
		return `(HTTP ${response.status}, ${body.length}+ chars)\n${redact(clamp(text, context.maxOutput * 4))}`;
	} catch (error) {
		return `(fetch failed: ${error instanceof Error ? error.message : String(error)})`;
	} finally {
		clearTimeout(timer);
	}
}

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_CHARS = 400_000;

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&rsquo;|&lsquo;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n")
		.trim();
}

function compareOutput(observed: string, expectation: { operator: string; value: string }): boolean {
	switch (expectation.operator) {
		case "equals":
			return observed === expectation.value;
		case "contains":
			return observed.includes(expectation.value);
		case "matches":
			try {
				return new RegExp(expectation.value, "u").test(observed);
			} catch {
				return false;
			}
		case "numeric_equals":
			return Number(observed) === Number(expectation.value);
		case "numeric_greater_than":
			return Number(observed) > Number(expectation.value);
		case "numeric_less_than":
			return Number(observed) < Number(expectation.value);
		default:
			return false;
	}
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
	const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyOf === "function") return anyOf([a, b]);
	const controller = new AbortController();
	const forward = () => controller.abort();
	if (a.aborted || b.aborted) controller.abort();
	a.addEventListener("abort", forward, { once: true });
	b.addEventListener("abort", forward, { once: true });
	return controller.signal;
}
