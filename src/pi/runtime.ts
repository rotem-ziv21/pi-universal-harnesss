import { createCheckpointDetector } from "../checkpoints/detector.ts";
import { loadConfig, loadProjectConfig, updateConfig } from "../config/loader.ts";
import { ensureHarnessDirs, type HarnessPaths, isWritable, resolvePaths } from "../config/paths.ts";
import type { HarnessConfig, ProjectConfig } from "../config/schema.ts";
import { createTaskCompiler, degradedContract, looksSubstantive, type TaskCompiler } from "../contract/compiler.ts";
import { createModelContractReviewer, type ContractReviewer, findingLines, noopContractReviewer } from "../contract/reviewer.ts";
import type { TaskContract } from "../contract/schema.ts";
import { createEvidenceCollector, type ExecFn } from "../evidence/collector.ts";
import { createEvidencePlanner } from "../evidence/planner.ts";
import { createDeterministicJudge } from "../judges/deterministic.ts";
import type { Judge } from "../judges/judge.ts";
import { createModelJudge } from "../judges/model-judge.ts";
import { createOpenRouterJevJudge } from "../judges/openrouter-jev.ts";
import { createJudgeRouter, type JudgeRouter } from "../judges/router.ts";
import { createCurrentModelAdapter, createPinnedModelAdapter, type ModelAdapter, type PiModelHost } from "../models/model-adapter.ts";
import { createProgressMonitor } from "../progress/monitor.ts";
import { createKeyResolver, type KeyResolver, resolveOpenRouterKey, type ResolvedSecret } from "../security/secrets.ts";
import { createStateManager, restoreStateManager, type StateManager } from "../state/state-manager.ts";
import { errorMessage } from "../util/errors.ts";
import { newTaskId } from "../util/ids.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { createLogger, type Logger } from "../util/logger.ts";
import { createHarnessCore, type HarnessCore } from "./harness.ts";

/**
 * The runtime container.
 *
 * Holds everything that lives for the duration of a Pi session and rebuilds the parts
 * that depend on the active model whenever the model changes — which is what makes the
 * harness genuinely model-agnostic at runtime rather than only at startup (§6).
 *
 * There is deliberately no module-level mutable state anywhere in the harness (§68);
 * everything is reachable from this object.
 */

export interface HarnessRuntime {
	readonly paths: HarnessPaths;
	readonly config: HarnessConfig;
	readonly logger: Logger;
	/** Synchronous snapshot taken at startup; may be stale after `/login`. */
	readonly secret: ResolvedSecret;
	/** Live resolution, preferring Pi's own credentials. Use this for anything current. */
	readonly resolveKey: KeyResolver;
	readonly judge: JudgeRouter;
	readonly warnings: readonly string[];

	/** The active task, or undefined when none is running. */
	getTask(): ActiveTask | undefined;
	/** Rebind model-dependent components after `/model`. */
	refreshModel(host: PiModelHost): void;
	/** Compile, review, lock and activate a new task. */
	startTask(args: StartTaskArgs): Promise<ActiveTask>;
	/**
	 * The user sent a new substantive message while a task was active. Recompile the
	 * contract for the whole conversation and record it as a revision of the same
	 * task, so the event log, evidence and action history survive.
	 */
	reviseTask(args: StartTaskArgs): Promise<ActiveTask>;
	/** Load the most recent task for this cwd, if any (§49). */
	restoreTask(): ActiveTask | undefined;
	clearTask(): void;
	shouldCompile(prompt: string): boolean;
	readonly compilerId: string;
	readonly reviewerId: string;

	/** Which model each harness role currently uses, for display. */
	describeRoles(): RoleDescription[];
	/** Every model Pi can reach, for the picker. */
	availableModels(): Array<{ provider: string; id: string; label: string }>;
	/**
	 * Point a role at a different model, persist it, and rebind immediately.
	 * Passing undefined restores "follow whichever model Pi is on".
	 */
	setRoleModel(role: HarnessRole, ref: { provider: string; model: string } | undefined): RoleDescription;
}

export type HarnessRole = "compiler" | "reviewer";

export interface RoleDescription {
	readonly role: HarnessRole;
	readonly label: string;
	/** True when the role follows Pi's active model rather than a pinned one. */
	readonly followsPi: boolean;
	readonly modelId: string;
	readonly available: boolean;
}

export interface ActiveTask {
	readonly id: string;
	readonly state: StateManager;
	readonly core: HarnessCore;
	readonly contract: TaskContract;
	/** Findings from contract review, surfaced to the user at task start. */
	readonly reviewNotes: readonly string[];
	/** Questions the reviewer wants the user to answer before proceeding. */
	readonly openQuestions: readonly string[];
	readonly degraded: boolean;
}

export interface StartTaskArgs {
	readonly request: string;
	readonly cwd: string;
	readonly availableTools: readonly string[];
	readonly signal?: AbortSignal | undefined;
	readonly onProgress?: ((message: string) => void) | undefined;
}

export interface RuntimeDeps {
	readonly host: PiModelHost;
	readonly exec?: ExecFn | undefined;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly confirmWithUser?: ((title: string, message: string) => Promise<boolean>) | undefined;
	/** Overridable for tests. */
	readonly fetchImpl?: typeof fetch | undefined;
	/**
	 * Override the resolved locations.
	 *
	 * Required for tests to be hermetic. Without it `createRuntime` always resolved the
	 * real user config, so a test that changed a setting wrote to the developer's own
	 * machine — which is exactly what happened before this existed.
	 */
	readonly paths?: HarnessPaths | undefined;
}

interface ActiveTaskPointer {
	taskId: string;
	cwd: string;
	updatedAt: string;
}

/** The sentinel meaning "use whatever model Pi is currently on". */
export const FOLLOW_PI = "current-pi-model";

export function createRuntime(deps: RuntimeDeps): HarnessRuntime {
	const paths = deps.paths ?? resolvePaths();
	const warnings: string[] = [];

	let config: HarnessConfig;
	try {
		const loaded = loadConfig(paths);
		config = loaded.config;
		warnings.push(...loaded.warnings);
	} catch (e) {
		// A broken config must not disable the harness silently; fall back to defaults
		// and say so loudly.
		warnings.push(`${errorMessage(e)} — running with default configuration.`);
		config = loadConfig({ ...paths, configFile: "/nonexistent" }).config;
	}

	const logger = createLogger({ level: config.logging.level, file: paths.logFile, scope: "harness" });

	try {
		ensureHarnessDirs(paths);
	} catch (e) {
		warnings.push(`${errorMessage(e)} — persistence is disabled for this session.`);
		logger.error("state directory unavailable", { error: errorMessage(e) });
	}

	const stateWritable = isWritable(paths.harnessDir);
	if (!stateWritable) warnings.push(`Harness state directory is not writable: ${paths.harnessDir}`);

	const projectLoad = loadProjectConfig(deps.cwd, paths.configDirName, deps.projectTrusted);
	const projectConfig: ProjectConfig | undefined = projectLoad.config;
	warnings.push(...projectLoad.warnings);

	const secret = resolveOpenRouterKey(paths);

	/**
	 * Live key resolution, asked fresh on every use.
	 *
	 * `host` is Pi's ExtensionContext, which carries `modelRegistry`. Reading through it
	 * means `/login` is the single place a key is configured, and a login performed
	 * mid-session is picked up on the next gate with no reload.
	 */
	let resolveKey: KeyResolver = createKeyResolver({ paths, host: deps.host.modelRegistry });

	// --- model-dependent components ---
	//
	// Rebuilt both when Pi's own model changes and when the user repoints a harness
	// role with `/harness model`. Kept in one function so the two paths cannot drift.
	let host = deps.host;
	let compilerRef: ProviderRefLike = { ...config.compiler };
	let reviewerRef: ProviderRefLike = { ...config.contractReviewer };

	let modelAdapter!: ModelAdapter;
	let reviewerAdapter!: ModelAdapter;
	let compiler!: TaskCompiler;
	let reviewer!: ContractReviewer;

	const rebindModels = (): void => {
		modelAdapter = buildAdapter(host, compilerRef);
		reviewerAdapter = buildAdapter(host, reviewerRef);
		compiler = createTaskCompiler(modelAdapter, {
			logger,
			maxRepairAttempts: compilerRef.maxRepairAttempts ?? 2,
			timeoutMs: compilerRef.timeoutMs ?? config.compiler.timeoutMs,
		});
		reviewer = config.contractReviewer.enabled
			? createModelContractReviewer(reviewerAdapter, {
					logger,
					maxRepairAttempts: reviewerRef.maxRepairAttempts ?? 2,
					timeoutMs: reviewerRef.timeoutMs ?? config.contractReviewer.timeoutMs,
				})
			: noopContractReviewer;
	};

	rebindModels();

	/**
	 * Judge chain. The primary is Jev over OpenRouter; fallbacks come from config and
	 * go through the identical `Judge` interface, so nothing about the chain leaks into
	 * the Jev adapter (§41, §65.15).
	 */
	const primaryJudge: Judge | undefined =
		config.judge.enabled && config.judge.provider === "openrouter"
			? createOpenRouterJevJudge({
					config: config.judge,
					getApiKey: async () => (await resolveKey()).value,
					logger,
					...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
				})
			: undefined;

	const buildFallbacks = (): Judge[] =>
		config.judge.fallbackChain
			.map((name): Judge | undefined => {
				if (name === "model") return createModelJudge(modelAdapter, { config: config.judge, logger });
				if (name === "deterministic") return createDeterministicJudge({ config: config.judge });
				warnings.push(`Unknown Judge fallback "${name}" in config; ignoring it.`);
				return undefined;
			})
			.filter((j): j is Judge => j !== undefined);

	let fallbacks = buildFallbacks();

	const judge = createJudgeRouter({
		primary: primaryJudge,
		get fallbacks() {
			return fallbacks;
		},
		config: config.judge,
		logger,
		...(deps.confirmWithUser
			? {
					requestUserReview: async (request) =>
						(await deps.confirmWithUser?.(
							"Harness: the Judge is unavailable",
							[
								`The Judge could not evaluate a ${request.severity} checkpoint.`,
								"",
								`Action: ${request.proposedAction}`,
								`Checkpoint: ${request.checkpointType}`,
								`Reason: ${request.reason}`,
								"",
								"Allow this action anyway?",
							].join("\n"),
						)) ?? false,
				}
			: {}),
	});

	let task: ActiveTask | undefined;
	const ticker = createProgressTicker();
	const makeProgress = ticker.make;

	const buildCore = (state: StateManager): HarnessCore =>
		createHarnessCore({
			config,
			paths,
			state,
			detector: createCheckpointDetector({ config, judge: primaryJudge ?? fallbacks[0], logger }),
			planner: createEvidencePlanner({ logger }),
			collector: createEvidenceCollector({
				...(deps.exec ? { exec: deps.exec } : {}),
				reviewer: reviewerAdapter,
				...(deps.confirmWithUser
					? { confirm: (prompt: string) => deps.confirmWithUser?.("Harness: verification confirmation", prompt) ?? Promise.resolve(false) }
					: {}),
				logger,
			}),
			judge,
			progress: createProgressMonitor({ config, logger }),
			logger,
			projectConfig,
			...(deps.confirmWithUser ? { confirmWithUser: deps.confirmWithUser } : {}),
		});

	const rememberActiveTask = (taskId: string) => {
		try {
			writeJsonAtomic(paths.activeTaskFile, { taskId, cwd: deps.cwd, updatedAt: new Date().toISOString() } satisfies ActiveTaskPointer);
		} catch (e) {
			logger.warn("could not record the active task pointer", { error: errorMessage(e) });
		}
	};

	return {
		paths,
		config,
		logger,
		secret,
		judge,
		warnings,
		resolveKey: () => resolveKey(),

		get compilerId() {
			return modelAdapter.available ? modelAdapter.id : `${modelAdapter.id} (unavailable)`;
		},
		get reviewerId() {
			return config.contractReviewer.enabled ? reviewer.id : "disabled";
		},

		getTask: () => task,

		refreshModel(nextHost: PiModelHost): void {
			host = nextHost;
			resolveKey = createKeyResolver({ paths, host: nextHost.modelRegistry });
			rebindModels();
			fallbacks = buildFallbacks();
			logger.info("model rebound", { model: modelAdapter.id });
		},

		shouldCompile(prompt: string): boolean {
			if (!config.enabled) return false;
			if (config.contract.autoCompile === "off") return false;
			if (config.contract.autoCompile === "always") return prompt.trim().length > 0 && !prompt.trim().startsWith("/");
			return looksSubstantive(prompt, config.contract.substantiveMinChars);
		},

		/**
		 * Compile → review → (revise once) → lock → activate (§12, §14, §15).
		 *
		 * A single revision pass. Two models disagreeing forever is a real failure mode,
		 * and a second round rarely helps: if the reviewer still objects, the findings go
		 * to the user, who can settle it in one sentence.
		 */
		async startTask({ request, cwd, availableTools, signal, onProgress }): Promise<ActiveTask> {
			const compilerInput = {
				request,
				cwd,
				availableTools,
				projectConfig,
				...(signal ? { signal } : {}),
			};

			let contract: TaskContract;
			let degraded = false;
			const reviewNotes: string[] = [];
			const openQuestions: string[] = [];

			try {
				const progress = makeProgress(onProgress, modelAdapter.id);
				contract = await compiler.compile({ ...compilerInput, onAttempt: progress("Compiling the Task Contract") });

				if (config.contractReviewer.enabled) {
					const reviewProgress = makeProgress(onProgress, reviewerAdapter.id);
					const review = await reviewer.review({
						request,
						contract,
						...(signal ? { signal } : {}),
						onAttempt: reviewProgress("Reviewing the Task Contract"),
					});

					if (review.verdict === "REVISE") {
						reviewNotes.push(...findingLines(review));
						const retryProgress = makeProgress(onProgress, modelAdapter.id);

						try {
							contract = await compiler.compile({
								...compilerInput,
								reviewFindings: findingLines(review),
								onAttempt: retryProgress("Recompiling after review"),
							});
						} catch (e) {
							// Keep the first contract: an imperfect contract beats no contract.
							logger.warn("recompilation failed; keeping the original contract", { error: errorMessage(e) });
							reviewNotes.push(`Recompilation failed (${errorMessage(e)}); proceeding with the original contract.`);
						}
					} else if (review.verdict === "NEEDS_USER_INPUT") {
						reviewNotes.push(...findingLines(review));
						openQuestions.push(...review.questions);
					} else {
						reviewNotes.push(...findingLines(review));
					}
				}
			} catch (e) {
				// §limitation 5: degrade honestly rather than fabricating a contract.
				logger.error("contract compilation failed", { error: errorMessage(e) });
				contract = degradedContract(compilerInput, errorMessage(e));
				degraded = true;
				reviewNotes.push(`Contract compilation failed: ${errorMessage(e)}. Running with generic gating only.`);
			} finally {
				ticker.stop();
			}

			const state = createStateManager(contract.id, contract, {
				paths,
				persist: config.state.persist && stateWritable,
				snapshotEveryEvents: config.state.snapshotEveryEvents,
				logger,
			});

			state.emit("contract_compiled", { contract, degraded, compiledBy: modelAdapter.id });
			if (reviewNotes.length > 0) state.emit("contract_reviewed", { notes: reviewNotes, questions: openQuestions });
			state.lockContract(contract);

			task = {
				id: contract.id,
				state,
				core: buildCore(state),
				contract: state.getContract(),
				reviewNotes,
				openQuestions,
				degraded,
			};

			rememberActiveTask(contract.id);
			logger.info("task started", { taskId: contract.id, goal: contract.goal, degraded });
			return task;
		},

		async reviseTask({ request, cwd, availableTools, signal, onProgress }): Promise<ActiveTask> {
			const current = task;
			if (!current) return this.startTask({ request, cwd, availableTools, signal, onProgress });

			const previousContract = current.state.getContract();
			const compilerInput = { request, cwd, availableTools, projectConfig, previousContract, ...(signal ? { signal } : {}) };
			const reviewNotes: string[] = [];
			const openQuestions: string[] = [];

			let next: TaskContract;
			try {
				const progress = makeProgress(onProgress, modelAdapter.id);
				next = await compiler.compile({ ...compilerInput, onAttempt: progress("Updating the Task Contract") });

				if (config.contractReviewer.enabled) {
					const reviewProgress = makeProgress(onProgress, reviewerAdapter.id);
					const review = await reviewer.review({
						request: next.originalRequest,
						contract: next,
						...(signal ? { signal } : {}),
						onAttempt: reviewProgress("Reviewing the updated contract"),
					});
					reviewNotes.push(...findingLines(review));
					if (review.verdict === "REVISE") {
						try {
							next = await compiler.compile({
								...compilerInput,
								reviewFindings: findingLines(review),
								onAttempt: makeProgress(onProgress, modelAdapter.id)("Recompiling after review"),
							});
						} catch (e) {
							logger.warn("recompilation failed; keeping the first revision", { error: errorMessage(e) });
						}
					} else if (review.verdict === "NEEDS_USER_INPUT") {
						openQuestions.push(...review.questions);
					}
				}
			} finally {
				ticker.stop();
			}

			// The user authored the change, so dropping an earlier hard item is legitimate.
			current.state.reviseContract(next, { reason: `user follow-up: ${request.slice(0, 120)}`, source: "user" });
			if (reviewNotes.length > 0) current.state.emit("contract_reviewed", { notes: reviewNotes, questions: openQuestions });
			current.state.setPhase("plan", "contract revised by a user follow-up");

			task = {
				...current,
				contract: current.state.getContract(),
				reviewNotes,
				openQuestions,
				degraded: false,
			};
			rememberActiveTask(current.id);
			logger.info("task revised", { taskId: current.id, contractVersion: task.contract.version, goal: task.contract.goal });
			return task;
		},

		restoreTask(): ActiveTask | undefined {
			const pointer = readJsonFile<ActiveTaskPointer>(paths.activeTaskFile);
			if (!pointer?.taskId) return undefined;
			// A task belongs to the directory it was started in; restoring it elsewhere
			// would apply one project's contract to another's work.
			if (pointer.cwd !== deps.cwd) return undefined;

			const restored = restoreStateManager(paths, pointer.taskId, {
				persist: config.state.persist && stateWritable,
				snapshotEveryEvents: config.state.snapshotEveryEvents,
				logger,
			});
			if (!restored) return undefined;

			// Finished tasks are history, not something to resume into.
			if (restored.state.phase === "completed" || restored.state.phase === "abandoned") return undefined;

			/**
			 * So is a task nobody touched for a while. Resuming last week's contract on
			 * today's unrelated prompt in the same directory would block the user with
			 * rules they no longer remember agreeing to.
			 */
			const ageMs = Date.now() - Date.parse(restored.state.updatedAt);
			if (Number.isFinite(ageMs) && ageMs > config.state.resumeWithinHours * 3_600_000) {
				logger.info("not resuming a stale task", { taskId: pointer.taskId, ageHours: Math.round(ageMs / 3_600_000) });
				return undefined;
			}

			task = {
				id: pointer.taskId,
				state: restored.manager,
				core: buildCore(restored.manager),
				contract: restored.state.contract,
				reviewNotes: [],
				openQuestions: [],
				degraded: false,
			};
			return task;
		},

		describeRoles(): RoleDescription[] {
			const describe = (role: HarnessRole, ref: ProviderRefLike, adapter: ModelAdapter): RoleDescription => {
				const followsPi = ref.provider === FOLLOW_PI || !ref.model;
				return {
					role,
					label: role === "compiler" ? "Task Compiler" : "Contract Reviewer",
					followsPi,
					modelId: adapter.id,
					available: adapter.available,
				};
			};
			return [
				describe("compiler", compilerRef, modelAdapter),
				describe("reviewer", reviewerRef, reviewerAdapter),
			];
		},

		availableModels() {
			const listed = host.modelRegistry?.getAvailable?.() ?? [];
			const seen = new Set<string>();
			const out: Array<{ provider: string; id: string; label: string }> = [];

			for (const m of listed) {
				const label = `${m.provider}/${m.id}`;
				if (seen.has(label)) continue;
				seen.add(label);
				out.push({ provider: m.provider, id: m.id, label });
			}

			// Pi's active model may not appear in the catalogue (a provider registered by
			// another extension, for instance). Never offer a list that omits it.
			if (host.model) {
				const label = `${host.model.provider}/${host.model.id}`;
				if (!seen.has(label)) out.unshift({ provider: host.model.provider, id: host.model.id, label });
			}

			return out.sort((a, b) => a.label.localeCompare(b.label));
		},

		setRoleModel(role: HarnessRole, ref): RoleDescription {
			const next: ProviderRefLike = ref
				? { provider: ref.provider, model: ref.model }
				: { provider: FOLLOW_PI, model: undefined };

			const key = role === "compiler" ? "compiler" : "contractReviewer";

			if (role === "compiler") compilerRef = { ...compilerRef, ...next };
			else reviewerRef = { ...reviewerRef, ...next };

			rebindModels();
			fallbacks = buildFallbacks(); // The model fallback Judge follows the compiler.

			// Persist so the choice survives a restart. A write failure must not undo the
			// in-memory change the user just asked for, so it degrades to a warning.
			try {
				updateConfig(paths, { [key]: { provider: next.provider, model: next.model } } as never);
			} catch (e) {
				logger.warn("could not persist the role model change", { role, error: errorMessage(e) });
			}

			logger.info("harness role model changed", { role, model: next.model ?? FOLLOW_PI });
			const described = this.describeRoles().find((r) => r.role === role);
			return described!;
		},

		clearTask(): void {
			task?.state.flush();
			task = undefined;
			try {
				writeJsonAtomic(paths.activeTaskFile, { taskId: "", cwd: deps.cwd, updatedAt: new Date().toISOString() });
			} catch {
				// Not worth failing over.
			}
		},
	};
}

interface ProviderRefLike {
	provider: string;
	model?: string | undefined;
	maxRepairAttempts?: number | undefined;
	timeoutMs?: number | undefined;
}

/** Build a model adapter from a `ProviderRef`, honouring an explicit pin. */
function buildAdapter(host: PiModelHost, ref: { provider: string; model?: string | undefined }): ModelAdapter {
	if (ref.provider !== "current-pi-model" && ref.model) {
		return createPinnedModelAdapter(host, ref.provider, ref.model);
	}
	return createCurrentModelAdapter(host);
}

/** A stable task id for callers that need one before compilation. */
export const provisionalTaskId = newTaskId;

/**
 * Progress messages that show elapsed time and which attempt is running.
 *
 * A local model can take minutes for one call, and a bare "Reviewing…" is
 * indistinguishable from a hang. Showing the model, the attempt and a ticking counter
 * is the difference between "it is working" and "something is broken".
 */
/**
 * One ticker per runtime. A new attempt replaces it; `stop()` ends it. An earlier
 * version left every interval running for 30 minutes, so "Compiling · 321s" kept
 * overwriting the real status long after the contract was compiled — which looks
 * exactly like a hang.
 */
function createProgressTicker() {
	let timer: NodeJS.Timeout | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const make = (
		onProgress: ((message: string) => void) | undefined,
		modelId: string,
	): ((label: string) => ((attempt: number, total: number) => void) | undefined) => {
		return (label: string) => {
			if (!onProgress) return undefined;

			return (attempt: number, total: number): void => {
				stop();
				const started = Date.now();
				const suffix = total > 1 && attempt > 1 ? ` · retry ${attempt - 1}/${total - 1}` : "";

				const tick = () => {
					const seconds = Math.round((Date.now() - started) / 1000);
					onProgress(`${label} · ${modelId} · ${seconds}s${suffix}`);
				};
				tick();

				// Unref'd so a pending tick can never hold the process open at shutdown.
				timer = setInterval(tick, 1000);
				if (typeof timer.unref === "function") timer.unref();
			};
		};
	};
	return { make, stop };
}
