import { displayPath } from "../config/paths.ts";
import { updateConfig } from "../config/loader.ts";
import { QUESTIONS_VERSION } from "../decide/questions.ts";
import type { DecisionRecord } from "../decide/decision-log.ts";
import { changedFiles, freshChecks } from "../decide/evidence.ts";
import { runDoctor } from "./doctor.ts";
import { checkPermissions, deleteSecret, describeSource, OPENROUTER_ENV_VAR, resolveOpenRouterKey, writeSecret } from "../security/secrets.ts";
import { fingerprint } from "../security/redact.ts";
import { errorMessage } from "../util/errors.ts";
import type { HarnessRuntime } from "./runtime.ts";
import type { PiExtensionAPI } from "./extension.ts";

/**
 * `/harness …` commands. Secrets are never printed: `status` shows a fingerprint,
 * `setup` reads the key through an input and writes it at mode 0600.
 */

export const REPORT_WIDGET = "harness-report";

export interface CommandDeps {
	getRuntime(): HarnessRuntime | undefined;
	bootstrap(ctx: any): HarnessRuntime;
}

const SUBCOMMANDS = ["status", "why", "log", "evidence", "mode", "setup", "doctor", "enable", "disable", "help"] as const;

export function registerCommands(pi: PiExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("harness", {
		description: "Harness status, last decision, decision log, mode, setup, doctor",
		getArgumentCompletions: (prefix: string) => {
			const matches = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: any) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				await dispatch(sub, rest.join(" "), deps.getRuntime() ?? deps.bootstrap(ctx), ctx, pi);
			} catch (e) {
				show(ctx, pi, `Harness command failed: ${errorMessage(e)}`);
			}
		},
	});
}

async function dispatch(sub: string, argument: string, rt: HarnessRuntime, ctx: any, pi: PiExtensionAPI): Promise<void> {
	switch (sub) {
		case "status":
			return show(ctx, pi, await statusText(rt));
		case "why": {
			const last = rt.decisions.last() ?? rt.decisions.tail(1)[0];
			return show(ctx, pi, last ? renderRecord(last, true) : "No decision recorded yet.");
		}
		case "log": {
			const count = Math.min(Math.max(Number.parseInt(argument, 10) || 15, 1), 200);
			const records = rt.decisions.tail(count);
			return show(ctx, pi, records.length > 0 ? [`Last ${records.length} decision(s) — ${displayPath(rt.decisions.path)}`, "", ...records.map((r) => renderRecord(r, false))].join("\n") : "The decision log is empty.");
		}
		case "evidence":
			return show(ctx, pi, evidenceText(rt));
		case "mode": {
			if (argument !== "enforce" && argument !== "observe") return show(ctx, pi, `Mode is ${rt.config.mode}. Use /harness mode enforce|observe.`);
			updateConfig(rt.paths, { mode: argument });
			return show(ctx, pi, `Mode set to ${argument}. Run /reload for it to take effect.`);
		}
		case "enable":
		case "disable": {
			updateConfig(rt.paths, { enabled: sub === "enable" });
			return show(ctx, pi, `Harness ${sub}d. Run /reload for it to take effect.`);
		}
		case "setup":
			return setup(rt, ctx, pi);
		case "doctor":
			return show(ctx, pi, await runDoctor({ paths: rt.paths, config: rt.config, secret: await rt.resolveKey() }));
		default:
			return show(ctx, pi, helpText());
	}
}

async function statusText(rt: HarnessRuntime): Promise<string> {
	const key = await rt.resolveKey();
	const stats = rt.jev.stats();
	const cost = rt.config.judge.inputCostPerMillion > 0 ? (stats.inputTokens / 1_000_000) * rt.config.judge.inputCostPerMillion : 0;
	const evidence = rt.gates.evidence();
	return [
		`Harness: ${rt.config.enabled ? "enabled" : "disabled"}, mode ${rt.config.mode}`,
		`Judge: ${rt.jev.model} — key ${key.source === "none" ? "MISSING (run /login → OpenRouter)" : `${describeSource(key.source)} (${key.fingerprint})`}`,
		`Judge calls this session: ${stats.calls} ok, ${stats.failures} failed, avg ${stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0}ms, ~$${cost.toFixed(4)}`,
		`Question pack: ${QUESTIONS_VERSION}`,
		`This run: ${changedFiles(evidence).length} file(s) changed, ${evidence.checks.length} check(s), ${freshChecks(evidence).filter((c) => c.passed).length} passing after the last change`,
		`Decision log: ${displayPath(rt.decisions.path)}`,
	].join("\n");
}

function evidenceText(rt: HarnessRuntime): string {
	const evidence = rt.gates.evidence();
	const lines = [`Request: ${rt.gates.userRequest() || "(none yet)"}`, "", "Changes:"];
	for (const m of evidence.mutations) lines.push(`  #${m.seq} ${m.tool}: ${m.paths.join(", ")}`);
	if (evidence.mutations.length === 0) lines.push("  (none)");
	lines.push("", "Checks:");
	for (const c of evidence.checks) lines.push(`  #${c.seq} ${c.passed ? "PASS" : "FAIL"} ${c.command} → ${c.summary}`);
	if (evidence.checks.length === 0) lines.push("  (none)");
	return lines.join("\n");
}

function renderRecord(r: DecisionRecord, full: boolean): string {
	const head = `${r.ts.slice(11, 19)} ${r.kind.padEnd(6)} ${r.verdict.padEnd(14)} ${r.source.padEnd(8)} ${r.summary ?? ""}${r.reason ? ` — ${r.reason}` : ""}`;
	if (!full) return head;
	return [
		head,
		...(r.model ? [`model: ${r.model}${r.latencyMs !== undefined ? `, ${r.latencyMs}ms` : ""}`] : []),
		...(r.error ? [`error: ${r.error}`] : []),
		...(r.answers ? ["answers:", JSON.stringify(r.answers, null, 2)] : []),
		...(r.state ? ["state sent to the Judge:", JSON.stringify(r.state, null, 2)] : []),
	].join("\n");
}

function helpText(): string {
	return [
		"/harness status     mode, Judge key and usage, what this run changed and checked",
		"/harness why        the last decision in full: state, answers, verdict",
		"/harness log [n]    the last n decisions",
		"/harness evidence   changes and checks the harness observed in this run",
		"/harness mode enforce|observe",
		"/harness setup      store an OpenRouter key (prefer /login → OpenRouter)",
		"/harness doctor     environment and Judge connectivity checks",
		"/harness enable|disable",
	].join("\n");
}

async function setup(rt: HarnessRuntime, ctx: any, pi: PiExtensionAPI): Promise<void> {
	if (!ctx.hasUI) return show(ctx, pi, `/harness setup needs an interactive session. Set ${OPENROUTER_ENV_VAR} in your environment instead.`);

	const current = await rt.resolveKey();
	if (current.source === "pi") {
		const replace = await ctx.ui.confirm(
			"Harness setup",
			`Pi already has an OpenRouter key from /login (${current.fingerprint}), and the harness reads it directly.\n\nStore a second copy anyway?`,
		);
		if (!replace) return show(ctx, pi, "Nothing changed. The harness keeps using Pi's own credentials.");
	}
	if (current.source === "env") {
		const replace = await ctx.ui.confirm(
			"Harness setup",
			`${OPENROUTER_ENV_VAR} is set in your environment (${current.fingerprint}) and takes priority over a stored key.\n\nStore one anyway?`,
		);
		if (!replace) return show(ctx, pi, "Setup cancelled. The environment variable remains in use.");
	}

	const key = await ctx.ui.input("OpenRouter API key", "sk-or-v1-…");
	if (!key?.trim()) {
		if (current.source === "store" && (await ctx.ui.confirm("Harness setup", "No key entered. Remove the stored key?"))) {
			deleteSecret(rt.paths, OPENROUTER_ENV_VAR);
			return show(ctx, pi, "Stored OpenRouter key removed.");
		}
		return show(ctx, pi, "Setup cancelled; nothing was changed.");
	}

	const trimmed = key.trim();
	writeSecret(rt.paths, OPENROUTER_ENV_VAR, trimmed);
	const permissions = checkPermissions(rt.paths);
	show(ctx, pi, [`OpenRouter key stored (${fingerprint(trimmed)}).`, `  Location:    ${displayPath(rt.paths.secretsFile)}`, `  Permissions: ${permissions.message}`, "", "Verifying connectivity…"].join("\n"));
	const report = await runDoctor({ paths: rt.paths, config: rt.config, secret: resolveOpenRouterKey(rt.paths), onlyJudge: true });
	show(ctx, pi, report);
}

function show(ctx: any, pi: PiExtensionAPI, text: string): void {
	if (!ctx.hasUI) {
		process.stdout.write(`${text}\n`);
		return;
	}
	// While the agent is busy a custom message only lands when the turn ends, so draw it now as a widget too.
	const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
	if (busy && typeof ctx.ui?.setWidget === "function") {
		ctx.ui.setWidget(REPORT_WIDGET, [...text.split("\n"), "", "(live harness report — clears when the agent settles)"]);
	}
	pi.sendMessage({ customType: "harness_report", content: text, display: true }, { triggerTurn: false });
}
