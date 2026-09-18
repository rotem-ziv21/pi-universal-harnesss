import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ModelAdapter } from "../models/model-adapter.ts";
import { redact } from "../security/redact.ts";
import { clamp } from "../util/json.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { CollectedEvidence, CollectionResult, EvidencePlan, EvidenceRequest } from "./types.ts";

/**
 * The Evidence Collector (§28).
 *
 * Executes an `EvidencePlan` and returns observations with full provenance. Everything
 * it produces is Level 1 trust — runtime evidence — except reviewer output, which is
 * Level 3 and labelled as such, because a model's opinion does not become a fact by
 * being collected.
 *
 * Safety: commands come from the Evidence Planner, which only emits things it could
 * derive from the contract or from project config. The collector adds a second
 * barrier anyway — no shell metacharacters, a hard timeout, and output truncation —
 * because "the planner validated it" is exactly the assumption that ages badly.
 */

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/** Injected by the Pi adapter, which owns `pi.exec`. Replaceable in tests. */
export type ExecFn = (command: string, args: string[], options: { signal?: AbortSignal; cwd?: string }) => Promise<ExecResult>;

export interface EvidenceCollector {
	collect(args: {
		plan: EvidencePlan;
		cwd: string;
		signal?: AbortSignal | undefined;
	}): Promise<CollectionResult>;
}

export interface CollectorOptions {
	readonly exec?: ExecFn | undefined;
	/** Used for `reviewer` requests. Absent means those are reported as unavailable. */
	readonly reviewer?: ModelAdapter | undefined;
	readonly logger?: Logger;
	readonly commandTimeoutMs?: number;
	readonly maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 4_000;

export function createEvidenceCollector(options: CollectorOptions = {}): EvidenceCollector {
	const log = (options.logger ?? nullLogger).child("evidence:collect");
	const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

	return {
		async collect({ plan, cwd, signal }): Promise<CollectionResult> {
			const started = Date.now();
			const collected: CollectedEvidence[] = [];
			const failed: Array<{ requestId: string; reason: string }> = [];

			/**
			 * Sequential, not parallel. Evidence collection can run test suites and
			 * builds; several at once on the same working tree interfere with each other
			 * and produce evidence about a state that never existed.
			 */
			for (const request of plan.evidenceRequests) {
				if (signal?.aborted) {
					failed.push({ requestId: request.id, reason: "aborted" });
					continue;
				}

				try {
					const evidence = await collectOne(request, { cwd, signal, options, maxOutput });
					collected.push(evidence);
				} catch (e) {
					const reason = e instanceof Error ? e.message : String(e);
					log.warn("evidence collection failed", { request: request.id, kind: request.kind, reason });
					failed.push({ requestId: request.id, reason });
				}
			}

			const durationMs = Date.now() - started;
			log.info("evidence collected", { requests: plan.evidenceRequests.length, ok: collected.length, failed: failed.length, durationMs });
			return { collected, failed, durationMs };
		},
	};
}

async function collectOne(
	request: EvidenceRequest,
	ctx: { cwd: string; signal: AbortSignal | undefined; options: CollectorOptions; maxOutput: number },
): Promise<CollectedEvidence> {
	switch (request.kind) {
		case "command":
			return collectCommand(request, ctx);
		case "file_state":
			return collectFileState(request, ctx);
		case "reviewer":
			return collectReviewer(request, ctx);
		case "internal":
		case "prior_tool_output":
			return {
				requestId: request.id,
				requirementIds: request.requirementIds,
				type: request.kind,
				summary: `No collector is implemented for ${request.kind} requests.`,
				value: undefined,
				sourceType: "harness",
				source: "collector",
				trust: "runtime_evidence",
				freshnessClass: request.freshnessClass,
				ok: false,
				error: `unsupported request kind: ${request.kind}`,
			};
	}
}

async function collectCommand(
	request: EvidenceRequest,
	ctx: { cwd: string; signal: AbortSignal | undefined; options: CollectorOptions; maxOutput: number },
): Promise<CollectedEvidence> {
	const command = String(request.parameters.command ?? "");
	if (!command) throw new Error("command request has no command");
	if (!ctx.options.exec) throw new Error("no exec function is available to run evidence commands");

	// Second barrier: never pass anything that can chain, redirect or substitute.
	if (/[;&|><$(){}`\n]/.test(command)) {
		throw new Error(`refusing to run a command containing shell metacharacters: ${command}`);
	}

	const [program, ...args] = command.trim().split(/\s+/);
	if (!program) throw new Error("empty command");

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), ctx.options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS);

	try {
		const result = await ctx.options.exec(program, args, {
			cwd: ctx.cwd,
			...(ctx.signal ? { signal: anySignal(ctx.signal, timeout.signal) } : { signal: timeout.signal }),
		});

		const exitCode = result.exitCode ?? -1;
		const ok = exitCode === 0;
		const output = redact(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim());

		return {
			requestId: request.id,
			requirementIds: request.requirementIds,
			type: "command_result",
			// The summary is what reaches the Judge, so it leads with the decisive fact.
			summary: `exit ${exitCode} — ${clamp(output || "(no output)", 300)}`,
			value: { command, exitCode, output: clamp(output, ctx.maxOutput) },
			sourceType: "command",
			source: command,
			trust: "runtime_evidence",
			freshnessClass: request.freshnessClass,
			ok,
			...(ok ? {} : { error: `command exited with ${exitCode}` }),
		};
	} finally {
		clearTimeout(timer);
	}
}

function collectFileState(
	request: EvidenceRequest,
	ctx: { cwd: string; options: CollectorOptions; maxOutput: number },
): CollectedEvidence {
	const rawPath = String(request.parameters.path ?? "");
	if (!rawPath) throw new Error("file_state request has no path");

	const path = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
	const mode = String(request.parameters.mode ?? "hash_unchanged");

	try {
		const stats = statSync(path);

		if (mode === "path_absent") {
			return evidence(request, {
				type: "file_state",
				summary: `${rawPath} exists (expected absent)`,
				value: { path: rawPath, exists: true },
				source: path,
				ok: false,
				error: "path exists but was expected to be absent",
			});
		}

		// Hash only regular files; hashing a directory tree is unbounded work.
		const hash = stats.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32) : undefined;

		return evidence(request, {
			type: "file_state",
			summary: hash
				? `${rawPath} exists, size ${stats.size}, sha256:${hash.slice(0, 12)}…`
				: `${rawPath} exists (${stats.isDirectory() ? "directory" : "non-regular file"})`,
			value: { path: rawPath, exists: true, size: stats.size, modifiedAt: stats.mtime.toISOString(), ...(hash ? { hash } : {}) },
			source: path,
			ok: true,
			// A hash stays true exactly until that file changes (§21).
			validity: path,
		});
	} catch {
		const expectedAbsent = mode === "path_absent";
		return evidence(request, {
			type: "file_state",
			summary: `${rawPath} does not exist`,
			value: { path: rawPath, exists: false },
			source: path,
			ok: expectedAbsent,
			...(expectedAbsent ? {} : { error: "path does not exist" }),
		});
	}
}

/**
 * Reviewer evidence: a focused model judgement about something no command can settle.
 *
 * Trust level is `model_interpretation`, not `runtime_evidence`. This is the whole
 * point of §17 — a reviewer saying "yes, the image is about Kubernetes" is a useful
 * signal and is *not* the same kind of thing as an exit code.
 */
async function collectReviewer(
	request: EvidenceRequest,
	ctx: { signal: AbortSignal | undefined; options: CollectorOptions },
): Promise<CollectedEvidence> {
	const reviewer = ctx.options.reviewer;
	if (!reviewer?.available) throw new Error("no reviewer model is available");

	const question = String(request.parameters.question ?? request.description);
	const hint = request.parameters.hint ? String(request.parameters.hint) : undefined;

	const response = await reviewer.complete({
		systemPrompt:
			"You are an evidence reviewer for an execution harness. Answer the question about the current task state " +
			"in at most three sentences. State plainly what you can and cannot determine. Do not speculate, and do not " +
			"claim something is verified when you have not observed it. Begin your reply with VERIFIED, NOT_VERIFIED or " +
			"CANNOT_DETERMINE.",
		userPrompt: [
			`Task goal: ${request.parameters.goal ?? "(not specified)"}`,
			`Proposed action: ${request.parameters.proposedAction ?? "(not specified)"}`,
			"",
			`Question: ${question}`,
			...(hint ? [`How this should be verified: ${hint}`] : []),
		].join("\n"),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});

	const text = response.text.trim();
	const verified = /^VERIFIED\b/i.test(text);

	return evidence(request, {
		type: "reviewer_assessment",
		summary: clamp(text, 400),
		value: { question, response: text, model: response.model },
		source: `reviewer:${response.model}`,
		sourceType: "model",
		trust: "model_interpretation",
		ok: verified,
		...(verified ? {} : { error: "reviewer did not confirm" }),
	});
}

function evidence(
	request: EvidenceRequest,
	fields: {
		type: string;
		summary: string;
		value: unknown;
		source: string;
		ok: boolean;
		error?: string;
		validity?: string;
		sourceType?: CollectedEvidence["sourceType"];
		trust?: CollectedEvidence["trust"];
	},
): CollectedEvidence {
	return {
		requestId: request.id,
		requirementIds: request.requirementIds,
		type: fields.type,
		summary: fields.summary,
		value: fields.value,
		sourceType: fields.sourceType ?? "file",
		source: fields.source,
		trust: fields.trust ?? "runtime_evidence",
		freshnessClass: request.freshnessClass,
		ok: fields.ok,
		...(fields.error ? { error: fields.error } : {}),
		...(fields.validity ? { validity: fields.validity } : {}),
	};
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
