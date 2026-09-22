import { readFileSync } from "node:fs";
import { displayPath, isWritable } from "../config/paths.ts";
import { updateConfig } from "../config/loader.ts";
import { runDoctor } from "./doctor.ts";
import { checkPermissions, deleteSecret, describeSource, OPENROUTER_ENV_VAR, resolveOpenRouterKey, writeSecret } from "../security/secrets.ts";
import { fingerprint } from "../security/redact.ts";
import { redactValue } from "../security/redact.ts";
import { clamp } from "../util/json.ts";
import { errorMessage } from "../util/errors.ts";
import type { HarnessRuntime } from "./runtime.ts";
import type { PiExtensionAPI } from "./extension.ts";
import { renderStatus } from "./render.ts";

/**
 * `/harness …` commands (§53).
 *
 * One registered command with subcommands rather than a dozen top-level names, so the
 * user's command palette is not flooded by this extension.
 *
 * Secrets are never printed. `status` shows a fingerprint (`sk-or-…f4a2`); `setup`
 * reads the key through a masked input and writes it at mode 0600.
 */

export interface CommandDeps {
	getRuntime(): HarnessRuntime | undefined;
	bootstrap(ctx: any): HarnessRuntime;
}

const SUBCOMMANDS = [
	"status", "model", "setup", "doctor", "contract", "state", "events",
	"evidence", "decision", "judge", "judge-debug", "checkpoint-debug", "log",
	"enable", "disable", "abandon", "help",
] as const;

export function registerCommands(pi: PiExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("harness", {
		description: "Inspect and configure the universal harness (status, setup, doctor, contract, state, events, …)",
		getArgumentCompletions: (prefix: string) => {
			const matches = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: any) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const argument = rest.join(" ");

			try {
				const runtime = deps.getRuntime() ?? deps.bootstrap(ctx);
				await dispatch(sub, argument, runtime, ctx, pi);
			} catch (e) {
				show(ctx, pi, `Harness command failed: ${errorMessage(e)}`);
			}
		},
	});
}

async function dispatch(sub: string, argument: string, rt: HarnessRuntime, ctx: any, pi: PiExtensionAPI): Promise<void> {
	switch (sub) {
		case "status": {
			// Ask Pi for the key now: a /login since startup should be reflected.
			const live = await rt.resolveKey();
			return show(ctx, pi, statusText(rt, live));
		}

		case "model":
			return chooseModel(rt, argument, ctx, pi);

		case "setup":
			return setup(rt, ctx, pi);

		case "doctor": {
			const report = await runDoctor({
				paths: rt.paths,
				config: rt.config,
				judge: rt.judge,
				secret: await rt.resolveKey(),
			});
			return show(ctx, pi, report);
		}

		case "contract":
			return show(ctx, pi, contractText(rt));

		case "state":
			return show(ctx, pi, stateText(rt));

		case "events":
			return show(ctx, pi, eventsText(rt, argument));

		case "evidence":
			return show(ctx, pi, evidenceText(rt));

		case "decision":
			return show(ctx, pi, decisionText(rt, argument));

		case "judge":
			return show(ctx, pi, judgeText(rt));


		case "judge-debug":
			return show(ctx, pi, judgeDebugText(rt, argument));

		case "checkpoint-debug":
			return show(ctx, pi, checkpointDebugText(rt, argument));
		case "log":
			return show(ctx, pi, logText(rt, argument));

		case "enable":
		case "disable": {
			const enabled = sub === "enable";
			updateConfig(rt.paths, { enabled });
			return show(
				ctx,
				pi,
				`Harness ${enabled ? "enabled" : "disabled"} in ${displayPath(rt.paths.configFile)}.\nRun /reload for it to take effect in this session.`,
			);
		}

		case "abandon": {
			const task = rt.getTask();
			if (!task) return show(ctx, pi, "No active task.");
			task.state.abandonTask(argument || "abandoned by the user");
			rt.clearTask();
			return show(ctx, pi, `Task ${task.id} abandoned. Its event log is kept at ${displayPath(rt.paths.tasksDir)}.`);
		}

		default:
			return show(ctx, pi, helpText());
	}
}

// --- model selection ---

/**
 * `/harness model` — control which model runs the Task Compiler and Contract Reviewer.
 *
 * These are separate from Pi's own `/model`, and deliberately so. The compiler and
 * reviewer do a narrow job — read a request faithfully and emit strict JSON — and the
 * best model for that is often not the one you want writing code. It is also the job
 * where a cheap local model is most defensible, since it runs twice per task.
 *
 * Changes apply immediately. Editing the config file by hand needs a reload; this does
 * not, which is the entire reason the command exists.
 */
async function chooseModel(rt: HarnessRuntime, argument: string, ctx: any, pi: PiExtensionAPI): Promise<void> {
	const [roleArg, ...rest] = argument.trim().split(/\s+/).filter(Boolean);
	const target = rest.join(" ").trim();

	if (!roleArg) return show(ctx, pi, rolesText(rt));

	const role = roleArg === "compiler" ? "compiler" : roleArg === "reviewer" ? "reviewer" : undefined;
	if (!role) {
		return show(ctx, pi, `Unknown role "${roleArg}".\n\n${rolesText(rt)}`);
	}

	// Explicit target: /harness model compiler llama-cpp/qwen27b-local
	if (target) {
		if (target === "auto" || target === "pi") {
			const described = rt.setRoleModel(role, undefined);
			return show(ctx, pi, `${described.label} now follows Pi's active model (${described.modelId}).`);
		}

		const parsed = parseModelRef(target);
		if (!parsed) {
			return show(ctx, pi, `"${target}" is not a provider/model reference. Expected something like llama-cpp/qwen27b-local.`);
		}

		const described = rt.setRoleModel(role, parsed);
		const warning = described.available
			? ""
			: "\n\nWarning: Pi does not list this model as reachable. Check /model for the exact ids.";
		return show(ctx, pi, `${described.label} is now pinned to ${described.modelId}.${warning}`);
	}

	// No target: offer a picker.
	if (!ctx.hasUI) {
		return show(ctx, pi, `Specify a model: /harness model ${role} <provider/model>\n\n${rolesText(rt)}`);
	}

	const models = rt.availableModels();
	if (models.length === 0) {
		return show(ctx, pi, "Pi reports no available models. Run /login first.");
	}

	const FOLLOW = "· follow Pi's active model";
	const choice = await ctx.ui.select(
		`Model for the ${role === "compiler" ? "Task Compiler" : "Contract Reviewer"}`,
		[FOLLOW, ...models.map((m) => m.label)],
	);
	if (!choice) return show(ctx, pi, "Cancelled; nothing changed.");

	const described = rt.setRoleModel(role, choice === FOLLOW ? undefined : parseModelRef(choice));
	return show(
		ctx,
		pi,
		described.followsPi
			? `${described.label} now follows Pi's active model (${described.modelId}).`
			: `${described.label} is now pinned to ${described.modelId}.`,
	);
}

function rolesText(rt: HarnessRuntime): string {
	const lines: string[] = ["Harness model roles", ""];

	for (const role of rt.describeRoles()) {
		const how = role.followsPi ? "follows Pi's active model" : "pinned";
		const health = role.available ? "" : "  ← Pi does not list this model as reachable";
		lines.push(`  ${role.label.padEnd(18)} ${role.modelId}   (${how})${health}`);
	}

	lines.push(
		"",
		"These are separate from Pi's own /model. The compiler and reviewer read your",
		"request and emit strict JSON; that is a different job from writing code, and it",
		"runs twice per task rather than on every action.",
		"",
		"  /harness model compiler              pick from a list",
		"  /harness model reviewer <prov/model> set directly",
		"  /harness model compiler auto         go back to following Pi",
		"",
		"Changes apply immediately — no reload. Run /model to see valid ids.",
		"",
		"Worth knowing: giving the reviewer a different model from the compiler makes the",
		"review worth more, because two models fail in different ways. A model reviewing",
		"its own output shares its own blind spots.",
	);

	return lines.join("\n");
}

/** `provider/model`, where the model id may itself contain slashes. */
function parseModelRef(text: string): { provider: string; model: string } | undefined {
	const trimmed = text.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

// --- setup (§33, §35) ---

async function setup(rt: HarnessRuntime, ctx: any, pi: PiExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		return show(ctx, pi, `/harness setup needs an interactive session. Set ${OPENROUTER_ENV_VAR} in your environment instead.`);
	}

	const current = await rt.resolveKey();

	if (current.source === "pi") {
		const replace = await ctx.ui.confirm(
			"Harness setup",
			`Pi already has an OpenRouter key from /login (${current.fingerprint}).\n\n` +
				"The harness reads that key directly, so there is nothing to configure here. Storing a second copy " +
				"means two places to rotate.\n\nStore one anyway?",
		);
		if (!replace) return show(ctx, pi, "Nothing changed. The harness will keep using Pi's own credentials.");
	}

	if (current.source === "env") {
		const replace = await ctx.ui.confirm(
			"Harness setup",
			`${OPENROUTER_ENV_VAR} is already set in your environment (${current.fingerprint}).\n\n` +
				"The environment variable always takes priority over the local store, so storing a key here would have no effect " +
				"until you unset it.\n\nStore one anyway?",
		);
		if (!replace) return show(ctx, pi, "Setup cancelled. The environment variable remains in use.");
	}

	const key = await ctx.ui.input("OpenRouter API key", "sk-or-v1-…");
	if (!key?.trim()) {
		if (current.source === "store") {
			const remove = await ctx.ui.confirm("Harness setup", "No key entered. Remove the stored key?");
			if (remove) {
				deleteSecret(rt.paths, OPENROUTER_ENV_VAR);
				return show(ctx, pi, "Stored OpenRouter key removed.");
			}
		}
		return show(ctx, pi, "Setup cancelled; nothing was changed.");
	}

	const trimmed = key.trim();
	writeSecret(rt.paths, OPENROUTER_ENV_VAR, trimmed);

	const permissions = checkPermissions(rt.paths);
	const lines = [
		"OpenRouter key stored.",
		`  Location:    ${displayPath(rt.paths.secretsFile)}`,
		`  Permissions: ${permissions.message}`,
		`  Key:         ${fingerprint(trimmed)}`,
		"",
		"This file is machine-local and is never committed to git.",
		"",
		"Verifying connectivity…",
	];
	show(ctx, pi, lines.join("\n"));

	// Prove it works now rather than at the first blocked action.
	const report = await runDoctor({
		paths: rt.paths,
		config: rt.config,
		judge: rt.judge,
		secret: resolveOpenRouterKey(rt.paths),
		onlyJudge: true,
	});

	show(ctx, pi, `${report}\n\nRun /reload so this session picks up the new key.`);
}

// --- renderers ---

function statusText(rt: HarnessRuntime, live = rt.secret): string {
	const task = rt.getTask();
	const stats = rt.judge.stats();
	const described = rt.judge.describe();

	const roles = rt.describeRoles();
	const describeRole = (name: "compiler" | "reviewer", fallback: string): string => {
		const role = roles.find((r) => r.role === name);
		if (!role) return fallback;
		const how = role.followsPi ? "follows Pi" : "pinned";
		return `${role.modelId} (${how})${role.available ? "" : " — UNREACHABLE"}`;
	};

	return renderStatus({
		enabled: rt.config.enabled,
		compiler: describeRole("compiler", rt.compilerId),
		reviewer: describeRole("reviewer", rt.reviewerId),
		judgePrimary: described.primary,
		judgeFallbacks: described.fallbacks,
		judgeEnabled: described.enabled,
		keySource: describeSource(live.source),
		keyFingerprint: live.fingerprint,
		statePath: rt.paths.harnessDir,
		stateHealthy: isWritable(rt.paths.harnessDir),
		...(task
			? {
					task: {
						id: task.id,
						goal: task.contract.goal,
						phase: task.state.getState().phase,
						contractVersion: task.state.getState().contractVersion,
						stateVersion: task.state.getVersion(),
					},
				}
			: {}),
		judgeStats: {
			calls: stats.calls,
			failures: stats.failures,
			totalLatencyMs: stats.totalLatencyMs,
			...(stats.estimatedCostUsd !== undefined ? { estimatedCostUsd: stats.estimatedCostUsd } : {}),
		},
	});
}

function contractText(rt: HarnessRuntime): string {
	const task = rt.getTask();
	if (!task) return "No active task. The harness compiles a contract when you give Pi a substantive request.";

	const contract = task.contract;
	const lines: string[] = [];

	lines.push(`Task ${contract.id} · contract v${contract.version} · ${task.state.getState().phase}`);
	lines.push("");
	lines.push(`Goal: ${contract.goal}`);
	lines.push(`Workspace scopes: ${contract.workspace?.allowedScopes.join(", ") || contract.metadata.cwd || "(runtime cwd)"}`);
	lines.push(`Protected resources: ${contract.workspace?.protectedResources.join(", ") || "(none)"}`);
	lines.push("");
	lines.push("Original request:");
	lines.push(indent(clamp(contract.originalRequest, 1000)));

	const section = (title: string, items: ReadonlyArray<{ id: string; description: string; source?: string; priority?: string; status?: string }>) => {
		if (items.length === 0) return;
		lines.push("", `${title}:`);
		for (const item of items) {
			const tags = [item.source, item.priority, item.status].filter(Boolean).join("/");
			lines.push(`  ${item.id}${tags ? ` [${tags}]` : ""} ${item.description}`);
		}
	};

	section("Requirements", contract.requirements);
	section("Constraints", contract.constraints);
	section("Success conditions", contract.successConditions);
	section("Forbidden conditions", contract.forbiddenConditions);
	section("Critical actions", contract.criticalActions);

	if (contract.ambiguities.length > 0) {
		lines.push("", "Ambiguities:");
		for (const a of contract.ambiguities) {
			lines.push(`  ${a.id} ${a.blocking ? "[blocking] " : ""}${a.description}`);
			if (a.defaultInterpretation) lines.push(`      default: ${a.defaultInterpretation}`);
		}
	}

	if (contract.assumptions.length > 0) {
		lines.push("", "Assumptions (compiler-derived, NOT user instructions):");
		for (const a of contract.assumptions) lines.push(`  ${a.id} ${a.description} (confidence ${a.confidence.toFixed(2)})`);
	}

	if (task.reviewNotes.length > 0) {
		lines.push("", "Contract review findings:");
		for (const note of task.reviewNotes) lines.push(`  - ${note}`);
	}

	if (task.openQuestions.length > 0) {
		lines.push("", "The reviewer wants you to clarify:");
		for (const q of task.openQuestions) lines.push(`  ? ${q}`);
	}

	const revisions = task.state.getState().revisions;
	if (revisions.length > 0) {
		lines.push("", "Revision history:");
		for (const r of revisions) {
			lines.push(`  v${r.fromVersion} → v${r.toVersion} (${r.source}) ${r.reason}`);
			for (const change of r.changes.slice(0, 8)) {
				lines.push(`      ${change.change} ${change.field}${change.itemId ? `/${change.itemId}` : ""}`);
			}
		}
	}

	return lines.join("\n");
}

function stateText(rt: HarnessRuntime): string {
	const task = rt.getTask();
	if (!task) return "No active task.";

	const s = task.state.getState();
	const lines: string[] = [];

	lines.push(`Task ${s.taskId}`);
	lines.push(`Phase:           ${s.phase}`);
	lines.push(`State version:   ${s.stateVersion}`);
	lines.push(`Contract:        v${s.contractVersion} (${s.revisions.length} revision(s))`);
	lines.push(`Started:         ${s.startedAt}`);
	lines.push(`Updated:         ${s.updatedAt}`);
	lines.push("");
	lines.push("Counters:");
	for (const [key, value] of Object.entries(s.counters)) lines.push(`  ${key.padEnd(20)} ${value}`);

	lines.push("");
	lines.push(`Verified facts:  ${s.verifiedFacts.filter((f) => !f.supersededBy).length} current, ${s.verifiedFacts.length} total`);
	lines.push(`Hypotheses:      ${s.hypotheses.filter((h) => h.status === "open").length} open, ${s.hypotheses.length} total`);
	lines.push(`Evidence:        ${s.evidence.filter((e) => !e.supersededBy).length} current, ${s.evidence.length} total`);
	lines.push(`Resources:       ${s.workspace.resources.filter((resource) => resource.status === "active").length} active, ${s.workspace.resources.length} tracked`);
	lines.push(`Workspace root:  ${s.workspace.initialWorkingDirectory}`);
	lines.push(`Allowed scopes:  ${s.workspace.allowedScopes.join(", ")}`);
	lines.push(`Protected:       ${s.workspace.protectedResources.join(", ") || "(none)"}`);

	if (s.workspace.resources.length > 0) {
		lines.push("", "Resource registry:");
		for (const resource of s.workspace.resources.slice(-20)) {
			lines.push(
				`  [${resource.status}] ${resource.lastOperation} ${resource.uri} ` +
					`(${resource.kind}; ${resource.provenance}; ${resource.scope}; action ${resource.lastActionId})`,
			);
		}
	}

	if (s.verifiedFacts.length > 0) {
		lines.push("", "Verified facts (runtime evidence only):");
		for (const f of s.verifiedFacts.slice(-10)) {
			lines.push(`  ${f.supersededBy ? "[superseded] " : ""}${f.statement}`);
		}
	}

	const openHypotheses = s.hypotheses.filter((h) => h.status === "open" || h.status === "supported");
	if (openHypotheses.length > 0) {
		lines.push("", "Hypotheses (NOT facts):");
		for (const h of openHypotheses.slice(-10)) {
			lines.push(`  [${h.status}, ${h.confidence.toFixed(2)}] ${h.statement}`);
		}
	}

	if (s.lastCompletionEvaluation) {
		lines.push("", "Last completion evaluation:");
		for (const condition of s.lastCompletionEvaluation.conditions) {
			lines.push(`  [${condition.status}${condition.deterministic ? "/deterministic" : "/semantic"}] ${condition.id} ${condition.description}`);
			lines.push(`    ${condition.reason}`);
		}
	}

	if (s.lastCompletionFeedback) {
		lines.push("", "Last completion rejection:");
		lines.push(indent(clamp(s.lastCompletionFeedback, 800)));
	}

	return lines.join("\n");
}

function eventsText(rt: HarnessRuntime, argument: string): string {
	const task = rt.getTask();
	if (!task) return "No active task.";

	const limit = Number.parseInt(argument, 10);
	const count = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 30;
	const events = task.state.readEvents().slice(-count);

	if (events.length === 0) return "No events recorded yet.";

	const lines = [`Last ${events.length} event(s) — full log: ${displayPath(task.state.eventStorePath)}`, ""];
	for (const event of events) {
		lines.push(`v${String(event.stateVersion).padStart(4)} ${event.at.slice(11, 19)} ${event.type.padEnd(24)} ${summarizePayload(event.type, event.payload)}`);
	}
	return lines.join("\n");
}

function evidenceText(rt: HarnessRuntime): string {
	const task = rt.getTask();
	if (!task) return "No active task.";

	const evidence = task.state.getState().evidence;
	if (evidence.length === 0) return "No evidence collected yet.";

	const lines = [`${evidence.length} evidence item(s):`, ""];
	for (const item of evidence.slice(-40)) {
		const marker = item.supersededBy ? "[superseded]" : `[${item.trust}]`;
		lines.push(`${item.id} ${marker} [${item.result}] v${item.stateVersion} ${item.type} via ${item.source}`);
		lines.push(`    requirements: ${item.requirementIds.join(", ") || "(none)"}`);
		lines.push(`    ${clamp(item.summary, 200)}`);
		lines.push(`    freshness: ${item.freshnessClass}${item.validity ? ` (until ${item.validity} changes)` : ""}`);
	}
	return lines.join("\n");
}

function decisionText(rt: HarnessRuntime, argument: string): string {
	const task = rt.getTask();
	if (!task) return "No active task.";

	const decisions = task.state.getState().decisions;
	if (decisions.length === 0) return "No Judge decisions recorded yet.";

	const selected = argument ? decisions.filter((d) => d.id === argument || d.checkpointId === argument) : decisions.slice(-5);
	if (selected.length === 0) return `No decision matching "${argument}".`;

	const lines: string[] = [];
	for (const d of selected) {
		lines.push(`${d.id} — ${d.decision}${d.applied ? "" : " (NOT APPLIED)"}`);
		lines.push(`  checkpoint:  ${d.checkpointId}`);
		lines.push(`  judge:       ${d.judgeId}`);
		lines.push(`  confidence:  ${d.confidence.toFixed(2)}`);
		lines.push(`  state:       v${d.stateVersion}`);
		lines.push(`  at:          ${d.at}${d.latencyMs !== undefined ? ` (${d.latencyMs}ms)` : ""}`);
		if (d.staleReason) lines.push(`  stale:       ${d.staleReason}`);
		if (d.reasons.length > 0) {
			lines.push("  reasons:");
			for (const r of d.reasons) lines.push(`    - ${r}`);
		}
		if (d.missingEvidence.length > 0) {
			lines.push("  missing:");
			for (const m of d.missingEvidence) lines.push(`    - ${m}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function judgeText(rt: HarnessRuntime): string {
	const described = rt.judge.describe();
	const stats = rt.judge.stats();
	const lines: string[] = [];

	lines.push(`Judge enabled:   ${described.enabled}`);
	lines.push(`Primary:         ${described.primary ?? "(none)"}`);
	lines.push(`Fallbacks:       ${described.fallbacks.join(" → ") || "(none)"}`);
	lines.push(`Endpoint:        ${rt.config.judge.baseUrl}${rt.config.judge.decisionsPath}`);
	lines.push(`Model:           ${rt.config.judge.model}`);
	lines.push(`Key:             ${rt.secret.source === "none" ? "not configured" : `${describeSource(rt.secret.source)} ${rt.secret.fingerprint}`}`);
	lines.push(`Failure policy:  critical=${rt.config.judge.failurePolicy.critical}, noncritical=${rt.config.judge.failurePolicy.noncritical}`);
	lines.push("");
	lines.push(`Calls:           ${stats.calls}`);
	lines.push(`Retries:         ${stats.retries}`);
	lines.push(`Failures:        ${stats.failures}`);
	if (stats.calls > 0) lines.push(`Avg latency:     ${Math.round(stats.totalLatencyMs / stats.calls)}ms`);
	lines.push(`Input tokens:    ${stats.inputTokens}`);
	lines.push(`Output tokens:   ${stats.outputTokens}`);
	if (stats.estimatedCostUsd !== undefined) {
		lines.push(`Estimated cost:  $${stats.estimatedCostUsd.toFixed(5)} (at $${rt.config.judge.inputCostPerMillion}/M input)`);
	}

	const byJudge = Object.entries(stats.byJudge).filter(([, s]) => s.calls > 0);
	if (byJudge.length > 0) {
		lines.push("", "Per judge:");
		for (const [id, s] of byJudge) {
			lines.push(`  ${id}: ${s.calls} call(s), ${s.failures} failure(s)`);
		}
	}

	return lines.join("\n");
}

function judgeDebugText(rt: HarnessRuntime, argument: string): string {
	const task = rt.getTask();
	if (!task) return "No active task.";
	const full = argument.split(/\s+/).includes("full");
	const selector = argument.split(/\s+/).find((part) => part && part !== "full");
	const decisions = task.state.getState().decisions.filter((decision) => decision.debug);
	const selected = selector
		? decisions.filter((decision) => decision.id === selector || decision.checkpointId === selector)
		: decisions.slice(-10);
	if (selected.length === 0) return "No captured Judge payloads match this request.";

	const lines: string[] = [];
	let previousSemanticHash: string | undefined;
	for (const decision of selected) {
		const debug = decision.debug!;
		const request = debug.request as { questions?: Record<string, unknown> };
		const requirementIds = Object.keys(request.questions ?? {})
			.filter((id) => id.startsWith("req_"))
			.map((id) => id.slice(4));
		lines.push(`${decision.checkpointId} · ${decision.id}`);
		lines.push(`  requirements: ${requirementIds.join(", ") || "(none)"}`);
		lines.push(`  stateVersion: v${decision.stateVersion}`);
		lines.push(`  evidence:     ${debug.evidenceIds.join(", ") || "(none)"}`);
		lines.push(`  payload hash: ${debug.requestHash}`);
		lines.push(`  semantic hash:${debug.semanticHash}`);
		if (previousSemanticHash) {
			lines.push(`  equivalent to previous: ${previousSemanticHash === debug.semanticHash ? "yes" : "no"}`);
		}
		lines.push(`  decision:     ${decision.decision}`);
		lines.push(`  confidence:   ${decision.confidence.toFixed(2)}`);
		if (decision.detail?.requirementSupport) {
			lines.push(`  requirement support: ${JSON.stringify(decision.detail.requirementSupport)}`);
		}
		if (full) {
			lines.push("  exact redacted request:");
			lines.push(indent(JSON.stringify(redactValue(debug.request), null, 2)));
			lines.push("  exact normalized response:");
			lines.push(
				indent(
					JSON.stringify(
						redactValue({
							decision: decision.decision,
							confidence: decision.confidence,
							detail: decision.detail,
							rawProviderResponse: debug.response,
						}),
						null,
						2,
					),
				),
			);
		}
		lines.push("");
		previousSemanticHash = debug.semanticHash;
	}
	return lines.join("\n");
}

function checkpointDebugText(rt: HarnessRuntime, argument: string): string {
	const task = rt.getTask();
	if (!task) return "No active task.";
	const checkpoints = task.state.getState().checkpoints;
	const selected = argument
		? checkpoints.filter((checkpoint) => checkpoint.id === argument || checkpoint.actionId === argument)
		: checkpoints.slice(-5);
	if (selected.length === 0) return `No checkpoint matching "${argument}".`;

	const lines: string[] = [];
	for (const checkpoint of selected) {
		const semantics = checkpoint.actionSemantics;
		lines.push(`${checkpoint.id} — ${checkpoint.type} → ${(checkpoint.policyDecision ?? "gate").toUpperCase()}`);
		if (!semantics) {
			lines.push("  normalized action: unavailable (legacy checkpoint record)", "");
			continue;
		}
		lines.push(`  phase:         ${checkpoint.phase}`);
		lines.push(`  risk:          ${checkpoint.severity}`);
		lines.push(`  action:        ${semantics.actionType}`);
		lines.push(`  mutation:      ${semantics.mutationType}`);
		lines.push(`  target:        ${semantics.target ?? "(none)"}`);
		lines.push(`  provenance:    ${semantics.targetProvenance}`);
		lines.push(`  scope:         ${semantics.targetScope}`);
		lines.push(`  reversibility: ${semantics.reversibility}`);
		lines.push(`  external:      ${semantics.externalSideEffect}`);
		lines.push(`  capabilities:  ${semantics.capabilities.join(", ") || "(none)"}`);
		for (const effect of semantics.effects) {
			lines.push(`  effect:        ${effect.operation} ${effect.kind} ${effect.uri} [${effect.provenance}/${effect.scope}]`);
		}
		lines.push("  matched constraints/signals:");
		for (const signal of checkpoint.signals) {
			lines.push(`    - [${signal.origin}/${signal.type}] ${signal.reason}`);
		}
		if (checkpoint.signals.length === 0) lines.push("    (none)");
		if (checkpoint.dependencyAnalysis) {
			lines.push(
				`  evidence dependency: ${checkpoint.dependencyAnalysis.dependsOnBlockedAction ? "dependent" : "independent"} — ${checkpoint.dependencyAnalysis.reason}`,
			);
		}
		lines.push(`  outcome:       ${checkpoint.outcome ?? "pending"}`, "");
	}
	return lines.join("\n");
}

/**
 * `/harness log` — the only window into nested model calls.
 *
 * Pi returns a completed message rather than a token stream to extensions, and its TUI
 * renders only its own agent loop, so a compiler or reviewer call is invisible while it
 * runs. At debug level the log holds the prompt and the raw reply, which is what you
 * need when a contract comes out wrong and you want to know whether the model or the
 * prompt was at fault.
 */
function logText(rt: HarnessRuntime, argument: string): string {
	const limit = Number.parseInt(argument, 10);
	const count = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 25;

	let raw: string;
	try {
		raw = readFileSync(rt.paths.logFile, "utf8");
	} catch {
		return `No log yet at ${displayPath(rt.paths.logFile)}.`;
	}

	const lines = raw.split("\n").filter(Boolean).slice(-count);
	if (lines.length === 0) return "The log is empty.";

	const out: string[] = [`Last ${lines.length} log line(s) — ${displayPath(rt.paths.logFile)}`, ""];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as { ts?: string; level?: string; scope?: string; msg?: string; data?: Record<string, unknown> };
			out.push(`${(entry.ts ?? "").slice(11, 19)} ${(entry.level ?? "").padEnd(5)} ${entry.scope ?? ""} — ${entry.msg ?? ""}`);

			const text = entry.data?.text ?? entry.data?.userPrompt;
			if (typeof text === "string") {
				for (const l of clamp(text, 1200).split("\n")) out.push(`        ${l}`);
			}
		} catch {
			out.push(line);
		}
	}

	if (rt.config.logging.level !== "debug") {
		out.push(
			"",
			`Log level is "${rt.config.logging.level}", so model prompts and replies are not recorded.`,
			'Set logging.level to "debug" in the harness config and /reload to capture them.',
		);
	}

	return out.join("\n");
}

function helpText(): string {
	return [
		"/harness <subcommand>",
		"",
		"  status      Configuration, current task, contract and state versions",
		"  model       Choose the model for the Task Compiler / Contract Reviewer",
		"  setup       Store the OpenRouter API key locally and verify connectivity",
		"  doctor      Full diagnostic: Pi, config, state, secrets, Judge reachability",
		"  contract    The current Task Contract, review findings and revision history",
		"  state       Canonical state: phase, versions, facts, hypotheses, counters",
		"  events [n]  The last n events from the append-only audit log (default 30)",
		"  evidence    Collected evidence with provenance, trust level and freshness",
		"  decision [id]  Judge decisions in full, including ones that were not applied",
		"  judge       Judge configuration and usage accounting",
		"  judge-debug [id] [full]  Payload hashes, evidence ids, normalized output; full is redacted",
		"  checkpoint-debug [id]  Action semantics, capability matches, dependency and policy",
		"  log [n]     Recent harness log lines; at debug level, model prompts and replies",
		"  enable      Enable the harness (persisted; needs /reload)",
		"  disable     Disable the harness (persisted; needs /reload)",
		"  abandon [reason]  End the current task without completing it",
	].join("\n");
}

// --- helpers ---

function summarizePayload(type: string, payload: Record<string, unknown>): string {
	const pick = (key: string): string | undefined => {
		const value = payload[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value === "object") {
			const obj = value as Record<string, unknown>;
			const inner = obj.summary ?? obj.description ?? obj.reason ?? obj.decision ?? obj.type;
			return inner ? String(inner) : undefined;
		}
		return String(value);
	};

	const candidates = ["reason", "decision", "checkpoint", "action", "evidence", "feedback", "phase", "goal", "warning"];
	for (const key of candidates) {
		const value = pick(key);
		if (value) return clamp(value, 90);
	}
	return type;
}

const indent = (text: string): string => text.split("\n").map((l) => `  ${l}`).join("\n");

/**
 * Show output.
 *
 * Long reports go into the transcript via `sendMessage` so they scroll and persist;
 * `notify` is a toast and truncates. `display: true` with `triggerTurn: false` means
 * the user sees it without spending a model call.
 */
export const REPORT_WIDGET = "harness-report";

function show(ctx: any, pi: PiExtensionAPI, text: string): void {
	if (!ctx.hasUI) {
		process.stdout.write(`${text}\n`);
		return;
	}
	/**
	 * A custom message with `triggerTurn: false` is appended to the transcript only
	 * when the current turn ends: Pi refuses to place it between a tool call and its
	 * result. While the agent is busy that looks like "nothing happened". So the
	 * report is also drawn immediately as a widget above the editor, and cleared
	 * when the run settles (see extension.ts).
	 */
	const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
	if (busy && typeof ctx.ui?.setWidget === "function") {
		ctx.ui.setWidget(REPORT_WIDGET, [...text.split("\n"), "", "(live harness report — clears when the agent settles)"]);
	}
	pi.sendMessage({ customType: "harness_report", content: text, display: true }, { triggerTurn: false });
}
