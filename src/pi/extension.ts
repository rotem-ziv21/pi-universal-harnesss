import { toProposedAction, createExecFn, extractCompletionClaim, summarizeResult } from "./pi-adapter.ts";
import { renderContractDigest } from "./render.ts";
import { createRuntime, type ActiveTask, type HarnessRuntime } from "./runtime.ts";
import { registerCommands, REPORT_WIDGET } from "./commands.ts";
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
					const phase = restored.state.getState().phase;
					ctx.ui.notify(
						`Harness: resumed task ${restored.id} (contract v${restored.contract.version}, state v${restored.state.getVersion()}, ${phase})` +
							(phase === "awaiting_user" ? " — it was paused for your decision; reply to continue or /harness abandon" : ""),
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

				/**
				 * This event fires only for prompts the user typed. A turn the harness
				 * itself triggers (a completion rejection sent with `triggerTurn`) goes
				 * through Pi's `_runAgentPrompt` directly and never lands here, so there is
				 * no risk of recompiling on our own feedback.
				 */
				const existing = rt.getTask();
				const args = {
					request: prompt,
					cwd: ctx.cwd ?? process.cwd(),
					availableTools: safeTools(pi),
					...(ctx.hasUI ? { onProgress: (m: string) => ctx.ui.setStatus("harness", m) } : {}),
				};

				if (existing) {
					// The harness paused the task for a human decision; the human just spoke.
					if (existing.state.getState().phase === "awaiting_user") {
						existing.state.setPhase("execute", "user replied");
					}
					updateStatus(rt, ctx);

					// A short reply ("yes", "go on") continues under the same contract. So does
					// the original request sent again after a restart: it is not new information.
					if (!rt.shouldCompile(prompt) || sameRequest(existing.contract.originalRequest, prompt)) return undefined;

					/**
					 * A genuine follow-up revises the contract — in the background. Blocking the
					 * turn here cost a full model timeout (three minutes on a busy local server)
					 * before the worker was even allowed to start, and the outcome of that wait
					 * was "continuing under the previous contract" anyway. The worker starts
					 * under the previous contract now; gates read the live contract, so the
					 * revision takes effect the moment it lands, and its digest is appended to
					 * the transcript for the model to see.
					 */
					if (compileInFlight) return undefined;
					if (ctx.hasUI) ctx.ui.setStatus("harness", "updating task contract in the background…");
					compileInFlight = rt
						.reviseTask(args)
						.then((task) => {
							if (ctx.hasUI) ctx.ui.notify(`Harness: contract updated to v${task.contract.version} for your follow-up.`, "info");
							pi.sendMessage(
								{ customType: CUSTOM_TYPE_CONTRACT, content: renderContractDigest(task.contract, task.state.getVersion()), display: false },
								{ triggerTurn: false },
							);
							return task;
						})
						.catch((e) => {
							rt.logger.error("task revision failed", { error: errorMessage(e) });
							if (ctx.hasUI) ctx.ui.notify(`Harness: could not update the contract (${errorMessage(e)}); the previous one stays in force.`, "warning");
							return undefined;
						})
						.finally(() => {
							compileInFlight = undefined;
							updateStatus(rt, ctx);
						});
					return undefined;
				}

				if (!rt.shouldCompile(prompt)) return undefined;

				// The first contract is compiled before the worker starts: gates need it.
				// Two model calls; tell the user why there is a pause.
				if (ctx.hasUI) ctx.ui.setStatus("harness", "compiling task contract…");

				compileInFlight = rt.startTask({ ...args, ...(ctx.signal ? { signal: ctx.signal } : {}) }).catch((e) => {
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

				const action = toProposedAction(
					{
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						input: event.input ?? {},
					},
					{ cwd: ctx.cwd ?? process.cwd(), contract: task.contract, state: task.state.getState() },
				);

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
				// The transcript now carries any report shown while the agent was busy.
				if (ctx.hasUI && typeof ctx.ui?.setWidget === "function") ctx.ui.setWidget(REPORT_WIDGET, undefined);

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
				// The harness already stopped the loop and is waiting for the user.
				if (phase === "awaiting_user") return;

				completionGateRunning = true;
				try {
					if (ctx.hasUI) ctx.ui.setStatus("harness", "verifying completion…");

					const outcome = await task.core.gateCompletion({
						cwd: ctx.cwd ?? process.cwd(),
						...(lastAssistantText ? { agentAssessment: extractCompletionClaim(lastAssistantText) } : {}),
						...(ctx.signal ? { signal: ctx.signal } : {}),
					});

					if (outcome.allowed) {
						/**
						 * "Verified" must mean something. A degraded contract has nothing to
						 * check, so its completion is trivially allowed — and must be reported
						 * as unverified, not dressed up as a pass.
						 */
						const degraded = task.degraded || task.contract.metadata.compiledBy === "degraded";
						const nothingToCheck =
							task.contract.requirements.length === 0 &&
							task.contract.successConditions.length === 0 &&
							task.contract.constraints.length === 0 &&
							task.contract.forbiddenConditions.length === 0;
						if (ctx.hasUI) {
							if (degraded) {
								ctx.ui.notify(
									"Harness: task ended — NOT verified. The contract could not be compiled (the compiler model did not answer), so there was nothing to check. See /harness model.",
									"warning",
								);
							} else if (nothingToCheck) {
								ctx.ui.notify("Harness: task ended — the contract listed nothing to verify.", "warning");
							} else {
								ctx.ui.notify(`Harness: task verified complete (state v${task.state.getVersion()})`, "info");
							}
						}
						rt.clearTask();
						updateStatus(rt, ctx);
						return;
					}

					if (outcome.resume !== false) {
						if (ctx.hasUI) ctx.ui.notify("Harness: completion rejected — continuing the task", "warning");
						pi.sendMessage(
							{
								customType: CUSTOM_TYPE_COMPLETION,
								content: outcome.message ?? "Completion rejected. Continue the task.",
								display: true,
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
						return;
					}

					/**
					 * The loop guard fired. The worker is NOT restarted; the message is shown
					 * and the user decides. With a UI, offer the one-click way out, because
					 * "the harness could not verify it" is often a fact about the harness's
					 * evidence routes, not about the work.
					 */
					pi.sendMessage(
						{ customType: CUSTOM_TYPE_COMPLETION, content: outcome.message ?? "Completion not verified.", display: true },
						{ triggerTurn: false },
					);
					if (!ctx.hasUI) {
						rt.logger.warn("completion loop halted with no UI; task left in awaiting_user");
						return;
					}
					const CONTINUE = "Continue — let the worker try again with the rejection feedback";
					const ACCEPT = "Accept as complete — I have looked at the result myself";
					const PAUSE = "Pause — I will reply with instructions, or run /harness abandon";
					let choice: string | undefined;
					try {
						choice = await ctx.ui.select("Harness: completion could not be verified. What now?", [CONTINUE, ACCEPT, PAUSE]);
					} catch {
						choice = undefined;
					}
					if (choice === CONTINUE) {
						task.state.emit("user_intervention", { approved: true, reason: "user chose to continue after halt", resetCompletionBudget: true, phase: "execute" });
						ctx.ui.notify("Harness: continuing — the worker gets a fresh rejection budget.", "info");
						pi.sendMessage(
							{ customType: CUSTOM_TYPE_COMPLETION, content: task.state.getState().lastCompletionFeedback ?? "Continue the task.", display: false },
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					} else if (choice === ACCEPT) {
						task.state.emit("user_intervention", { approved: true, reason: "completion accepted by user" });
						task.state.completeTask();
						rt.clearTask();
						ctx.ui.notify("Harness: task accepted as complete by you (unverified).", "info");
					} else {
						ctx.ui.notify("Harness: task paused. Reply to continue it, or run /harness abandon.", "warning");
					}
					updateStatus(rt, ctx);
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

/** The same words again (whitespace aside) are the same request, not a follow-up. */
function sameRequest(original: string, prompt: string): boolean {
	const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
	const a = norm(original);
	const b = norm(prompt);
	return a === b || a.includes(b);
}

function safeTools(pi: PiExtensionAPI): string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return [];
	}
}
