import { toProposedAction, createExecFn, extractCompletionClaim, summarizeResult } from "./pi-adapter.ts";
import { renderContractDigest } from "./render.ts";
import { createRuntime, type ActiveTask, type HarnessRuntime } from "./runtime.ts";
import { registerCommands } from "./commands.ts";
import { errorMessage } from "../util/errors.ts";
import { clamp } from "../util/json.ts";

/**
 * Pi wiring — where §45 stops being a diagram and becomes runtime behaviour.
 *
 * The critical hook is `tool_call`, which Pi 0.85.1 allows a handler to block by
 * returning `{ block: true, reason }`. That is the difference between this harness and
 * a prompt that asks a model to behave: the model does not choose whether the gate
 * runs.
 *
 * Every handler is wrapped so that a harness bug can never take Pi down. A crashed
 * gate fails *open* with a logged error, which is a deliberate trade: a harness that
 * bricks the agent whenever it has a bug is a harness people uninstall, and an
 * uninstalled harness governs nothing.
 */

/** Structural view of Pi's ExtensionAPI — declared so this file compiles without Pi. */
export interface PiExtensionAPI {
	on(event: string, handler: (event: any, ctx: any) => unknown): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void; getArgumentCompletions?: (prefix: string) => unknown }): void;
	sendMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }): void;
	exec(command: string, args: string[], options?: { signal?: AbortSignal; cwd?: string }): Promise<any>;
	getActiveTools(): string[];
}

export const CUSTOM_TYPE_CONTRACT = "harness_contract";
export const CUSTOM_TYPE_BLOCKED = "harness_blocked";
export const CUSTOM_TYPE_COMPLETION = "harness_completion_rejected";

export function activate(pi: PiExtensionAPI): void {
	/**
	 * One runtime per session, created lazily on `session_start` because `ctx` is where
	 * the cwd, model and trust state actually live.
	 */
	let runtime: HarnessRuntime | undefined;
	/** The assistant's last text, used only as untrusted `agentAssessment`. */
	let lastAssistantText = "";
	/** Guards against re-entering the completion gate from its own injected turn. */
	let completionGateRunning = false;
	/**
	 * Whether the session runtime is still alive.
	 *
	 * In print mode Pi can emit `agent_settled` *after* `session_shutdown`, and touching
	 * `ctx` at that point throws "this extension ctx is stale". The completion gate must
	 * not run against a torn-down session, so shutdown closes this latch.
	 */
	let sessionActive = false;
	let compileInFlight: Promise<ActiveTask | undefined> | undefined;

	const bootstrap = (ctx: any): HarnessRuntime => {
		if (runtime) return runtime;

		runtime = createRuntime({
			host: ctx,
			exec: createExecFn(pi),
			cwd: ctx.cwd ?? process.cwd(),
			projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false,
			...(ctx.hasUI
				? {
						confirmWithUser: async (title: string, message: string) => {
							try {
								return Boolean(await ctx.ui.confirm(title, message));
							} catch {
								// A failed prompt must not read as approval.
								return false;
							}
						},
					}
				: {}),
		});

		for (const warning of runtime.warnings) {
			runtime.logger.warn("startup warning", { warning });
			if (ctx.hasUI) ctx.ui.notify(`Harness: ${warning}`, "warning");
		}

		return runtime;
	};

	/** Never let a handler throw into Pi. */
	const guard = async <T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
		try {
			return await fn();
		} catch (e) {
			runtime?.logger.error(`handler failed: ${label}`, { error: errorMessage(e) });
			return fallback;
		}
	};

	// --- session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		await guard(
			"session_start",
			async () => {
				const rt = bootstrap(ctx);
				sessionActive = true;
				if (!rt.config.enabled) return;

				// §49: a task survives a Pi restart.
				const restored = rt.restoreTask();
				if (restored && ctx.hasUI) {
					ctx.ui.notify(
						`Harness: resumed task ${restored.id} (contract v${restored.contract.version}, state v${restored.state.getVersion()})`,
						"info",
					);
				}
				updateStatus(rt, ctx);
			},
			undefined,
		);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await guard(
			"session_shutdown",
			() => {
				sessionActive = false;
				runtime?.getTask()?.state.flush();
				runtime?.logger.info("session shutdown");
			},
			undefined,
		);
	});

	pi.on("model_select", async (_event, ctx) => {
		await guard("model_select", () => runtime?.refreshModel(ctx), undefined);
	});

	// --- task compilation ---

	pi.on("before_agent_start", async (event, ctx) => {
		return guard<unknown>(
			"before_agent_start",
			async () => {
				const rt = bootstrap(ctx);
				if (!rt.config.enabled) return undefined;

				const prompt = String(event.prompt ?? "").trim();

				// An active task continues; a new prompt refines it rather than replacing it.
				const existing = rt.getTask();
				if (existing) {
					updateStatus(rt, ctx);
					return undefined;
				}

				if (!rt.shouldCompile(prompt)) return undefined;

				// Compilation is two model calls; tell the user why there is a pause.
				if (ctx.hasUI) ctx.ui.setStatus("harness", "compiling task contract…");

				compileInFlight = rt
					.startTask({
						request: prompt,
						cwd: ctx.cwd ?? process.cwd(),
						availableTools: safeTools(pi),
						...(ctx.signal ? { signal: ctx.signal } : {}),
						...(ctx.hasUI ? { onProgress: (m: string) => ctx.ui.setStatus("harness", m) } : {}),
					})
					.catch((e) => {
						rt.logger.error("task start failed", { error: errorMessage(e) });
						if (ctx.hasUI) ctx.ui.notify(`Harness: could not start task governance — ${errorMessage(e)}`, "error");
						return undefined;
					});

				const task = await compileInFlight;
				compileInFlight = undefined;
				if (ctx.hasUI) ctx.ui.setStatus("harness", undefined);
				if (!task) return undefined;

				updateStatus(rt, ctx);

				if (ctx.hasUI && task.openQuestions.length > 0) {
					ctx.ui.notify(
						`Harness: the contract reviewer has ${task.openQuestions.length} question(s) — run /harness contract`,
						"warning",
					);
				}
				if (ctx.hasUI && task.degraded) {
					ctx.ui.notify("Harness: contract compilation failed; gating on generic signals only.", "warning");
				}

				/**
				 * Inject the contract into the worker's context.
				 *
				 * Not because the model must remember it — the harness enforces it either
				 * way — but because a model that can see the constraints is less likely to
				 * walk into them, which means fewer blocks and fewer wasted turns.
				 */
				return {
					message: {
						customType: CUSTOM_TYPE_CONTRACT,
						content: renderContractDigest(task.contract, task.state.getVersion()),
						display: false,
					},
				};
			},
			undefined,
		);
	});

	// --- the gate ---

	pi.on("tool_call", async (event, ctx) => {
		return guard<unknown>(
			"tool_call",
			async () => {
				const rt = runtime;
				const task = rt?.getTask();
				if (!rt || !task || !rt.config.enabled) return undefined;

				const action = toProposedAction({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.input ?? {},
				});

				if (ctx.hasUI) ctx.ui.setStatus("harness", `checking: ${clamp(action.summary, 40)}`);

				const outcome = await task.core.gateAction({
					action,
					cwd: ctx.cwd ?? process.cwd(),
					...(lastAssistantText ? { agentAssessment: lastAssistantText } : {}),
					...(ctx.signal ? { signal: ctx.signal } : {}),
				});

				updateStatus(rt, ctx);

				if (outcome.allowed) return undefined;

				// Surface the full explanation in the transcript, not just the block reason.
				if (outcome.message) {
					pi.sendMessage(
						{ customType: CUSTOM_TYPE_BLOCKED, content: outcome.message, display: true },
						{ triggerTurn: false },
					);
				}

				return {
					block: true,
					reason: outcome.message ?? "Blocked by the harness.",
					...(outcome.terminate ? { terminate: true } : {}),
				};
			},
			undefined,
		);
	});

	pi.on("tool_result", async (event, _ctx) => {
		await guard(
			"tool_result",
			() => {
				const task = runtime?.getTask();
				if (!task) return;
				task.core.recordToolResult({
					actionId: event.toolCallId,
					summary: summarizeResult(event.content, Boolean(event.isError)),
					isError: Boolean(event.isError),
				});
			},
			undefined,
		);
	});

	pi.on("message_end", async (event, _ctx) => {
		await guard(
			"message_end",
			() => {
				if (event.message?.role !== "assistant") return;
				const text = (event.message.content ?? [])
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n");
				if (text.trim()) lastAssistantText = text;
			},
			undefined,
		);
	});

	pi.on("turn_end", async (_event, _ctx) => {
		await guard("turn_end", () => runtime?.getTask()?.core.observeTurn(), undefined);
	});

	// --- the completion gate ---

	/**
	 * §44. `agent_settled` fires when Pi has nothing left to do on its own — no retry,
	 * no compaction, no queued follow-up. That is exactly the moment the worker has
	 * effectively declared the task finished, whatever words it used.
	 *
	 * On rejection the harness pushes structured feedback back with `triggerTurn`,
	 * which restarts the worker with the gaps spelled out rather than letting the
	 * session end on an unverified claim.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		await guard(
			"agent_settled",
			async () => {
				const rt = runtime;
				const task = rt?.getTask();
				if (!rt || !task || !rt.config.enabled) return;
				if (completionGateRunning) return;
				if (!sessionActive) {
					// The session is already torn down; ctx is stale and the gate cannot run.
					rt.logger.warn("completion gate skipped: the session ended before the agent settled");
					return;
				}

				const phase = task.state.getState().phase;
				if (phase === "completed" || phase === "abandoned") return;

				completionGateRunning = true;
				try {
					if (ctx.hasUI) ctx.ui.setStatus("harness", "verifying completion…");

					const outcome = await task.core.gateCompletion({
						cwd: ctx.cwd ?? process.cwd(),
						...(lastAssistantText ? { agentAssessment: extractCompletionClaim(lastAssistantText) } : {}),
						...(ctx.signal ? { signal: ctx.signal } : {}),
					});

					if (outcome.allowed) {
						if (ctx.hasUI) {
							ctx.ui.notify(`Harness: task verified complete (state v${task.state.getVersion()})`, "info");
						}
						rt.clearTask();
						updateStatus(rt, ctx);
						return;
					}

					if (ctx.hasUI) ctx.ui.notify("Harness: completion rejected — continuing the task", "warning");

					pi.sendMessage(
						{
							customType: CUSTOM_TYPE_COMPLETION,
							content: outcome.message ?? "Completion rejected. Continue the task.",
							display: true,
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} finally {
					completionGateRunning = false;
					if (ctx.hasUI) ctx.ui.setStatus("harness", undefined);
				}
			},
			undefined,
		);
	});

	// --- commands ---

	registerCommands(pi, {
		getRuntime: () => runtime,
		bootstrap,
	});
}

function updateStatus(runtime: HarnessRuntime, ctx: any): void {
	if (!ctx.hasUI || !runtime.config.ui.showStatus) return;

	const task = runtime.getTask();
	if (!task) {
		ctx.ui.setStatus("harness", runtime.config.enabled ? "harness: idle" : undefined);
		return;
	}

	const state = task.state.getState();
	ctx.ui.setStatus("harness", `harness: ${state.phase} c${state.contractVersion}/v${state.stateVersion}`);
}

function safeTools(pi: PiExtensionAPI): string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return [];
	}
}
