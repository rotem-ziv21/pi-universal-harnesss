import { displayPath, isWritable } from "../config/paths.ts";
import { updateConfig } from "../config/loader.ts";
import { runDoctor } from "./doctor.ts";
import { checkPermissions, deleteSecret, OPENROUTER_ENV_VAR, resolveOpenRouterKey, writeSecret } from "../security/secrets.ts";
import { fingerprint } from "../security/redact.ts";
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
	"status", "setup", "doctor", "contract", "state", "events",
	"evidence", "decision", "judge", "enable", "disable", "abandon", "help",
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
		case "status":
			return show(ctx, pi, statusText(rt));

		case "setup":
			return setup(rt, ctx, pi);

		case "doctor": {
			const report = await runDoctor({ paths: rt.paths, config: rt.config, judge: rt.judge, secret: rt.secret });
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

// --- setup (§33, §35) ---

async function setup(rt: HarnessRuntime, ctx: any, pi: PiExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		return show(ctx, pi, `/harness setup needs an interactive session. Set ${OPENROUTER_ENV_VAR} in your environment instead.`);
	}

	const current = resolveOpenRouterKey(rt.paths);

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

function statusText(rt: HarnessRuntime): string {
	const task = rt.getTask();
	const stats = rt.judge.stats();
	const described = rt.judge.describe();

	return renderStatus({
		enabled: rt.config.enabled,
		compiler: rt.compilerId,
		reviewer: rt.reviewerId,
		judgePrimary: described.primary,
		judgeFallbacks: described.fallbacks,
		judgeEnabled: described.enabled,
		keySource: rt.secret.source,
		keyFingerprint: rt.secret.fingerprint,
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
		lines.push(`${item.id} ${marker} v${item.stateVersion} ${item.type} via ${item.source}`);
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
	lines.push(`Key:             ${rt.secret.source === "none" ? "not configured" : `${rt.secret.source} ${rt.secret.fingerprint}`}`);
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

function helpText(): string {
	return [
		"/harness <subcommand>",
		"",
		"  status      Configuration, current task, contract and state versions",
		"  setup       Store the OpenRouter API key locally and verify connectivity",
		"  doctor      Full diagnostic: Pi, config, state, secrets, Judge reachability",
		"  contract    The current Task Contract, review findings and revision history",
		"  state       Canonical state: phase, versions, facts, hypotheses, counters",
		"  events [n]  The last n events from the append-only audit log (default 30)",
		"  evidence    Collected evidence with provenance, trust level and freshness",
		"  decision [id]  Judge decisions in full, including ones that were not applied",
		"  judge       Judge configuration and usage accounting",
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
function show(ctx: any, pi: PiExtensionAPI, text: string): void {
	if (!ctx.hasUI) {
		process.stdout.write(`${text}\n`);
		return;
	}
	pi.sendMessage({ customType: "harness_report", content: text, display: true }, { triggerTurn: false });
}
