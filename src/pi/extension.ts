import { diffSnapshots, snapshotTree, type TreeSnapshot } from "../resources/snapshot.ts";
import { summarize } from "../decide/gates.ts";
import { errorMessage } from "../util/errors.ts";
import { clamp } from "../util/json.ts";
import { registerCommands, REPORT_WIDGET } from "./commands.ts";
import { createRuntime, type HarnessRuntime } from "./runtime.ts";

/**
 * Pi wiring.
 *
 * Two hooks carry the harness, and the worker model cannot skip either:
 *   - `tool_call` runs the action gate before every tool call. A block returns
 *     `{ block, reason }`, and the reason becomes the tool result the model reads.
 *   - `agent_settled` runs the done gate when the worker stops. It may send the
 *     worker back once per user prompt; it never loops.
 *
 * `tool_result` feeds the evidence tracker with what actually happened, and
 * appends a note when the same call keeps failing the same way.
 *
 * Every handler is wrapped so a harness bug fails open with a logged error. A
 * harness that bricks the agent on its own bug gets uninstalled, and then it
 * governs nothing.
 */

/** Structural view of Pi's ExtensionAPI, declared so this file compiles without Pi. */
export interface PiExtensionAPI {
	on(event: string, handler: (event: any, ctx: any) => unknown): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void; getArgumentCompletions?: (prefix: string) => unknown }): void;
	sendMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }): void;
}

export const CUSTOM_TYPE_DONE = "harness_done_check";

export function activate(pi: PiExtensionAPI): void {
	let runtime: HarnessRuntime | undefined;
	let lastAssistantText = "";
	let lastStopReason: string | undefined;
	let doneGateRunning = false;
	let sessionActive = false;
	const pendingSnapshots = new Map<string, TreeSnapshot>();

	const bootstrap = (ctx: any): HarnessRuntime => {
		if (runtime) return runtime;
		runtime = createRuntime({
			host: { modelRegistry: ctx.modelRegistry },
			cwd: ctx.cwd ?? process.cwd(),
			projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false,
		});
		for (const warning of runtime.warnings) {
			runtime.logger.warn("startup warning", { warning });
			if (ctx.hasUI) ctx.ui.notify(`Harness: ${warning}`, "warning");
		}
		return runtime;
	};

	const guard = async <T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
		try {
			return await fn();
		} catch (e) {
			runtime?.logger.error(`handler failed: ${label}`, { error: errorMessage(e) });
			return fallback;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await guard(
			"session_start",
			() => {
				const rt = bootstrap(ctx);
				sessionActive = true;
				setStatus(ctx, rt, rt.config.enabled ? `harness: ${rt.config.mode}` : undefined);
			},
			undefined,
		);
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
	});

	pi.on("model_select", async (_event, ctx) => {
		await guard("model_select", () => runtime?.refreshHost({ modelRegistry: ctx.modelRegistry }), undefined);
	});

	/** The user's own words are the goal. Nothing rewrites them. */
	pi.on("before_agent_start", async (event, ctx) => {
		await guard(
			"before_agent_start",
			() => {
				const rt = bootstrap(ctx);
				if (!rt.config.enabled) return;
				lastAssistantText = "";
				rt.gates.onUserPrompt(String(event.prompt ?? ""));
			},
			undefined,
		);
		return undefined;
	});

	// --- action gate ---

	pi.on("tool_call", async (event, ctx) => {
		return guard<unknown>(
			"tool_call",
			async () => {
				const rt = runtime;
				if (!rt || !rt.config.enabled) return undefined;
				const toolName = String(event.toolName ?? "");
				const input = (event.input ?? {}) as Record<string, unknown>;

				setStatus(ctx, rt, `checking: ${clamp(summarize(toolName, input), 40)}`);
				const outcome = await rt.gates.gateAction({ toolName, input, ...(ctx.signal ? { signal: ctx.signal } : {}) });
				setStatus(ctx, rt, `harness: ${rt.config.mode}`);

				if (outcome.kind === "allow") {
					if (observesFilesystem(toolName)) {
						try {
							pendingSnapshots.set(event.toolCallId, snapshotTree(ctx.cwd ?? process.cwd()));
						} catch {
							// No observation is not a reason to block work.
						}
					}
					return undefined;
				}

				if (outcome.kind === "confirm" && ctx.hasUI) {
					let approved = false;
					try {
						approved = Boolean(await ctx.ui.confirm("Harness: allow this action?", `${summarize(toolName, input)}\n\nReason: ${outcome.reason}.`));
					} catch {
						approved = false;
					}
					rt.decisions.write({ kind: "action", mode: rt.config.mode, questionsVersion: "-", source: "user", verdict: approved ? "allow" : "block", reason: outcome.reason, summary: summarize(toolName, input) });
					if (approved) {
						rt.gates.approve(outcome.signature);
						if (observesFilesystem(toolName)) {
							try {
								pendingSnapshots.set(event.toolCallId, snapshotTree(ctx.cwd ?? process.cwd()));
							} catch {
								// as above
							}
						}
						return undefined;
					}
					return { block: true, reason: `${outcome.message}\nThe user declined this action.` };
				}

				if (ctx.hasUI) ctx.ui.notify(`Harness: ${outcome.kind === "block" ? "blocked" : "held"} — ${clamp(summarize(toolName, input), 80)}`, "warning");
				return { block: true, reason: outcome.message };
			},
			undefined,
		);
	});

	pi.on("tool_result", async (event, _ctx) => {
		return guard<unknown>(
			"tool_result",
			() => {
				const rt = runtime;
				if (!rt || !rt.config.enabled) return undefined;
				let changed: string[] | undefined;
				const before = pendingSnapshots.get(event.toolCallId);
				if (before) {
					pendingSnapshots.delete(event.toolCallId);
					try {
						const diff = diffSnapshots(before, snapshotTree(before.root));
						changed = [...diff.created, ...diff.modified, ...diff.deleted];
					} catch {
						changed = undefined;
					}
				}
				const note = rt.gates.recordResult({
					toolName: String(event.toolName ?? ""),
					input: (event.input ?? {}) as Record<string, unknown>,
					isError: Boolean(event.isError),
					output: textOf(event.content),
					changed,
				});
				if (!note) return undefined;
				return { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: `\n${note}` }] };
			},
			undefined,
		);
	});

	pi.on("message_end", async (event) => {
		await guard(
			"message_end",
			() => {
				if (event.message?.role !== "assistant") return;
				const text = textOf(event.message.content);
				if (text.trim()) lastAssistantText = text;
			},
			undefined,
		);
	});

	/** Why the run ended: an error or an abort is not a claim that the work is done. */
	pi.on("agent_end", async (event) => {
		await guard(
			"agent_end",
			() => {
				const messages: any[] = Array.isArray(event.messages) ? event.messages : [];
				const last = [...messages].reverse().find((m) => m?.role === "assistant");
				lastStopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
				const text = last ? textOf(last.content) : "";
				if (text.trim()) lastAssistantText = text;
			},
			undefined,
		);
	});

	// --- done gate ---

	pi.on("agent_settled", async (_event, ctx) => {
		await guard(
			"agent_settled",
			async () => {
				if (ctx.hasUI && typeof ctx.ui?.setWidget === "function") ctx.ui.setWidget(REPORT_WIDGET, undefined);
				const rt = runtime;
				if (!rt || !rt.config.enabled || doneGateRunning || !sessionActive) return;

				doneGateRunning = true;
				try {
					setStatus(ctx, rt, "harness: checking the result…");
					const outcome = await rt.gates.gateDone({
						finalMessage: lastAssistantText,
						stopReason: lastStopReason,
						...(ctx.signal ? { signal: ctx.signal } : {}),
					});
					lastStopReason = undefined;

					if (outcome.kind === "nudge") {
						if (ctx.hasUI) ctx.ui.notify(`Harness: ${clamp(outcome.why, 120)} — sending the agent back once`, "warning");
						pi.sendMessage({ customType: CUSTOM_TYPE_DONE, content: outcome.message, display: true }, { triggerTurn: true, deliverAs: "followUp" });
						return;
					}

					if (ctx.hasUI && outcome.kind === "accept") {
						if (outcome.status === "verified") ctx.ui.notify(`Harness: done, verified — ${clamp(outcome.why, 160)}.`, "info");
						else if (outcome.status === "partial") ctx.ui.notify(`Harness: done, partially verified — ${clamp(outcome.why, 200)}.`, "warning");
						else ctx.ui.notify(`Harness: done, not verified — ${clamp(outcome.why, 200)}.`, "warning");
					}
				} finally {
					doneGateRunning = false;
					setStatus(ctx, rt, `harness: ${rt.config.mode}`);
				}
			},
			undefined,
		);
	});

	registerCommands(pi, { getRuntime: () => runtime, bootstrap });
}

/** Tools whose file effects are not named by their arguments. */
function observesFilesystem(toolName: string): boolean {
	return !["read", "write", "edit", "ls", "grep", "find", "glob"].includes(toolName.toLowerCase());
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

function setStatus(ctx: any, rt: HarnessRuntime, message: string | undefined): void {
	if (!rt.config.ui.showStatus) return;
	try {
		if (ctx.hasUI) ctx.ui.setStatus("harness", message);
	} catch {
		// A retired context after /reload: nothing to show it on.
	}
}
