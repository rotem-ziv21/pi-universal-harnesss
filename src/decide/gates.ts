import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { redactValue } from "../security/redact.ts";
import { hashValue } from "../util/json.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { DecisionLog } from "./decision-log.ts";
import { changedFiles, createEvidenceTracker, freshChecks, type EvidenceTracker, type RunEvidence } from "./evidence.ts";
import { classifyToolCall } from "./hazards.ts";
import { noul, type JevClient } from "./jev.ts";
import {
	type ActionThresholds,
	decideAction,
	decideActionWithoutJudge,
	decideDone,
	deniedMessage,
	describeOutcome,
	type DoneThresholds,
	doneNudgeMessage,
	heldMessage,
	judgeOutcome,
	type OutcomeVerdict,
} from "./policy.ts";
import { ACTION_QUESTIONS, DONE_QUESTIONS, outcomeQuestions, QUESTIONS_VERSION } from "./questions.ts";
import { splitRequestItems } from "./request-items.ts";
import { createStuckDetector, type StuckDetector } from "./stuck.ts";

/**
 * The two gates, and the only places the harness decides anything.
 *
 * Action gate — every tool call, before it runs:
 *   fast layer (deny / confirm / allow) → otherwise one Jev request with the fixed
 *   action questions → policy → allow, confirm with the user, or block.
 *
 * Done gate — when the worker stops:
 *   code checks the evidence; no changes or a passing check since the last change
 *   settles it with no Judge call → otherwise one Jev request with the fixed done
 *   questions → at most one nudge per user prompt → then the run ends, reported as
 *   verified or not. The harness never loops the worker.
 *
 * Nothing here depends on which model the worker is. The inputs are the user's own
 * words and what the runtime observed.
 */

export type Mode = "enforce" | "observe";

export interface GatesConfig {
	readonly mode: Mode;
	readonly action: ActionThresholds;
	readonly done: DoneThresholds & { readonly enabled: boolean; readonly maxNudgesPerPrompt: number; readonly maxNudgesPerSession: number };
	readonly stuckThreshold: number;
}

export interface GatesDeps {
	readonly config: GatesConfig;
	readonly jev: JevClient;
	readonly log: DecisionLog;
	readonly cwd: string;
	readonly protectedPaths?: readonly string[] | undefined;
	readonly extraCheckCommands?: readonly string[] | undefined;
	readonly logger?: Logger;
}

export interface ActionRequest {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly signal?: AbortSignal | undefined;
}

export type ActionOutcome =
	| { readonly kind: "allow" }
	/** Needs the user. The caller asks if it can; otherwise it blocks with `message`. */
	| { readonly kind: "confirm"; readonly reason: string; readonly message: string; readonly signature: string }
	| { readonly kind: "block"; readonly reason: string; readonly message: string };

export interface DoneRequest {
	readonly finalMessage: string;
	/** Why the model stopped, from Pi's last assistant message. */
	readonly stopReason?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}

export type DoneStatus = "verified" | "partial" | "unverified";

export type DoneOutcome =
	/** Nothing to judge: no changes, or the stop was not a completion. */
	| { readonly kind: "skip"; readonly why: string; readonly verified: boolean }
	| { readonly kind: "accept"; readonly why: string; readonly verified: boolean; readonly status: DoneStatus; readonly outcome?: OutcomeVerdict | undefined }
	| { readonly kind: "nudge"; readonly why: string; readonly message: string };

export interface Gates {
	onUserPrompt(prompt: string): void;
	gateAction(request: ActionRequest): Promise<ActionOutcome>;
	/** Remember that the user approved this exact call, so an identical retry passes. */
	approve(signature: string): void;
	recordResult(result: { toolName: string; input: Record<string, unknown>; isError: boolean; output: string; changed?: readonly string[] | undefined }): string | undefined;
	gateDone(request: DoneRequest): Promise<DoneOutcome>;
	evidence(): RunEvidence;
	userRequest(): string;
	readonly mode: Mode;
}

export function createGates(deps: GatesDeps): Gates {
	const { config, jev, log } = deps;
	const logger = (deps.logger ?? nullLogger).child("gates");
	const tracker: EvidenceTracker = createEvidenceTracker({ extraCheckCommands: deps.extraCheckCommands });
	const stuck: StuckDetector = createStuckDetector({ threshold: config.stuckThreshold });
	const approved = new Set<string>();
	const prompts: string[] = [];
	let nudgesThisPrompt = 0;
	let nudgesThisSession = 0;

	const base = { mode: config.mode, questionsVersion: QUESTIONS_VERSION };
	const userRequest = (): string => prompts.map((p) => clip(p, 1500)).join("\n---\n");
	const latestPrompt = (): string => prompts.at(-1) ?? "";

	/** Observe mode logs what would have happened and lets everything but the deny list through. */
	const enforce = config.mode === "enforce";

	return {
		mode: config.mode,
		userRequest,
		evidence: () => tracker.get(),

		onUserPrompt(prompt) {
			const text = prompt.trim();
			if (!text) return;
			prompts.push(text);
			while (prompts.length > 3) prompts.shift();
			nudgesThisPrompt = 0;
			stuck.reset();
		},

		approve(signature) {
			approved.add(signature);
		},

		async gateAction({ toolName, input, signal }) {
			const summary = summarize(toolName, input);
			const signature = hashValue({ toolName, input });
			if (approved.has(signature)) {
				log.write({ ...base, kind: "action", source: "user", verdict: "allow", reason: "approved by the user earlier", summary });
				return { kind: "allow" };
			}

			const fast = classifyToolCall(toolName, input, { cwd: deps.cwd, protectedPaths: deps.protectedPaths });

			if (fast.kind === "allow") return { kind: "allow" };

			if (fast.kind === "deny") {
				// The deny list is a floor: enforced in observe mode too.
				log.write({ ...base, kind: "action", source: "fast", verdict: "block", reason: fast.reason, summary });
				return { kind: "block", reason: fast.reason, message: deniedMessage(summary, fast.reason) };
			}

			if (fast.kind === "confirm") {
				log.write({ ...base, kind: "action", source: "fast", verdict: enforce ? "confirm" : "allow(observe)", reason: fast.reason, summary });
				if (!enforce) return { kind: "allow" };
				return { kind: "confirm", reason: fast.reason, message: heldMessage(summary, fast.reason), signature };
			}

			const state = buildActionState(toolName, input, userRequest(), deps.cwd, fast.hints, fast.scripts);
			const result = await jev.ask(state, ACTION_QUESTIONS, signal);

			const verdict = result.ok ? decideAction(result.answers, config.action) : decideActionWithoutJudge(fast.hints);
			log.write({
				...base,
				kind: "action",
				source: result.ok ? "jev" : "fallback",
				verdict: enforce || verdict.kind === "allow" ? verdict.kind : `${verdict.kind}(observe)`,
				...(verdict.kind !== "allow" ? { reason: verdict.reason } : {}),
				summary,
				state,
				...(result.ok ? { answers: result.answers, model: result.model } : { error: `${result.code}: ${result.message}` }),
				latencyMs: result.latencyMs,
			});

			if (verdict.kind === "allow" || !enforce) return { kind: "allow" };
			if (verdict.kind === "block") return { kind: "block", reason: verdict.reason, message: deniedMessage(summary, verdict.reason) };
			return { kind: "confirm", reason: verdict.reason, message: heldMessage(summary, verdict.reason), signature };
		},

		recordResult({ toolName, input, isError, output, changed }) {
			tracker.record({ toolName, input, isError, output, changed });
			const note = stuck.observe(toolName, input, isError, output);
			if (note) log.write({ ...base, kind: "stuck", source: "fast", verdict: "note", summary: summarize(toolName, input) });
			return note;
		},

		async gateDone({ finalMessage, stopReason, signal }) {
			const evidence = tracker.get();
			const conclude = (outcome: DoneOutcome): DoneOutcome => {
				// A concluded run starts the next one clean; a nudge keeps the evidence for the retry.
				if (outcome.kind !== "nudge") tracker.reset();
				return outcome;
			};

			if (!config.done.enabled) return conclude({ kind: "skip", why: "the done check is disabled", verified: false });

			if (stopReason && ["error", "aborted", "length"].includes(stopReason)) {
				// Not a completion: the model errored, was stopped, or ran out of room. Keep the evidence.
				return { kind: "skip", why: `the model stopped with "${stopReason}", which is not a completion claim`, verified: false };
			}

			if (evidence.mutations.length === 0) {
				return conclude({ kind: "skip", why: "no files were changed", verified: false });
			}

			/**
			 * One Jev request answers everything: how the worker stopped (DONE_QUESTIONS)
			 * and, per requested item, whether the evidence shows it was carried out and
			 * exercised by a passed check (outcome questions). A passing check alone is
			 * not "verified": tests that cover three of six deliverables prove three.
			 */
			const items = splitRequestItems(latestPrompt());
			const freshPass = freshChecks(evidence).some((c) => c.passed);
			const state = buildDoneState(userRequest(), items, finalMessage, evidence, deps.cwd);
			const result = await jev.ask(state, { ...DONE_QUESTIONS, ...outcomeQuestions(items) }, signal);
			if (!result.ok) {
				log.write({ ...base, kind: "done", source: "fallback", verdict: "accept", reason: "Judge unavailable", state, error: `${result.code}: ${result.message}`, latencyMs: result.latencyMs });
				return conclude({
					kind: "accept",
					why: freshPass
						? `a check passed after the last change; the Judge is unavailable (${result.code}), so item coverage was not judged`
						: `the Judge is unavailable (${result.code}), so the claim could not be checked`,
					verified: freshPass,
					status: freshPass ? "partial" : "unverified",
				});
			}

			const stop = decideDone(result.answers, config.done);
			const checksApply = noul(result.answers, "verification_applies") >= config.done.applies;
			const outcome = judgeOutcome(result.answers, items, config.done, checksApply);
			const claimsDone = noul(result.answers, "claims_done") >= config.done.claimsDone;
			const stoppedForUser = stop.kind === "accept" && /ask the user|report a blocker/.test(stop.why);
			const wantNudge =
				!stoppedForUser &&
				claimsDone &&
				(outcome.missing.length > 0 || outcome.claimBeyond >= config.done.claimBeyond || (checksApply && !freshPass));
			const capped = nudgesThisPrompt >= config.done.maxNudgesPerPrompt || nudgesThisSession >= config.done.maxNudgesPerSession;
			const willNudge = wantNudge && enforce && !capped;
			const summary = describeOutcome(outcome, items);
			const why = stoppedForUser ? stop.why : wantNudge ? `the agent reports the work as done; ${summary}` : summary;

			log.write({
				...base,
				kind: "done",
				source: wantNudge && capped ? "cap" : "jev",
				verdict: willNudge ? "nudge" : wantNudge ? (enforce ? "accept(capped)" : "nudge(observe)") : `accept(${outcome.status})`,
				reason: why,
				state,
				answers: result.answers,
				model: result.model,
				latencyMs: result.latencyMs,
			});

			if (!willNudge) {
				return conclude({
					kind: "accept",
					why: wantNudge && capped ? `${why}; not sent back again` : why,
					verified: outcome.status === "verified",
					status: outcome.status,
					outcome,
				});
			}

			nudgesThisPrompt++;
			nudgesThisSession++;
			logger.info("done check: sending the worker back once", { why });
			return { kind: "nudge", why, message: doneNudgeMessage(evidence, noul(result.answers, "claims_verified") >= config.done.claimsDone, outcome) };
		},
	};
}

// --- state builders: facts only ---

export function buildActionState(
	toolName: string,
	input: Record<string, unknown>,
	userRequest: string,
	cwd: string,
	hints: readonly string[],
	scripts: readonly { path: string; content: string }[],
): Record<string, unknown> {
	return {
		user_request: userRequest || "(none)",
		action: { tool: toolName, arguments: clipArgs(input) },
		cwd,
		hints: hints.length > 0 ? hints : ["none"],
		...(scripts.length > 0 ? { local_scripts: scripts } : {}),
	};
}

export function buildDoneState(
	userRequest: string,
	items: readonly string[],
	finalMessage: string,
	evidence: RunEvidence,
	cwd: string,
): Record<string, unknown> {
	const files = changedFiles(evidence);
	const changes = files.slice(0, 20).map((path) => ({ path, ...observeFile(path, cwd) }));
	return redactValue({
		request: userRequest || "(none)",
		request_items: items,
		changes,
		changes_count: files.length,
		checks: evidence.checks.slice(-8).map((c) => ({ command: c.command, passed: c.passed, summary: c.summary })),
		checks_after_last_change: freshChecks(evidence).length,
		observations: evidence.observations.slice(-20).map((o) => ({ command: o.command, ok: o.ok, output: o.summary })),
		final_message: clip(finalMessage || "(no text)", 3000),
	});
}

/** What a changed file holds now: its head, or the fact that it is gone. Bounded so the state stays small. */
function observeFile(path: string, cwd: string): { kind: "present" | "missing"; bytes?: number; head?: string } {
	const full = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		const stats = statSync(full);
		if (!stats.isFile()) return { kind: "present", bytes: stats.size };
		const head = readFileSync(full).subarray(0, 4096);
		if (head.includes(0)) return { kind: "present", bytes: stats.size, head: "(binary)" };
		return { kind: "present", bytes: stats.size, head: clip(head.toString("utf8"), 600) };
	} catch {
		return { kind: "missing" };
	}
}

function clipArgs(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string") out[key] = clip(value, key === "command" ? 2000 : 1200);
		else if (Array.isArray(value)) out[key] = clip(JSON.stringify(value), 1500);
		else out[key] = value;
	}
	return out;
}

export function summarize(toolName: string, input: Record<string, unknown>): string {
	const command = input.command ?? input.cmd;
	if (typeof command === "string") return `${toolName}: ${clip(command.replace(/\s+/g, " "), 160)}`;
	const path = input.path ?? input.file_path ?? input.filePath;
	if (typeof path === "string") return `${toolName} ${path}`;
	return toolName;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
