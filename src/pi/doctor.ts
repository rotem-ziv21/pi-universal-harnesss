import { readFileSync } from "node:fs";
import { displayPath, discoverConfigDirName, type HarnessPaths, isWritable, pathExists } from "../config/paths.ts";
import type { HarnessConfig } from "../config/schema.ts";
import type { JudgeRouter } from "../judges/router.ts";
import { checkPermissions, type ResolvedSecret } from "../security/secrets.ts";
import { errorMessage } from "../util/errors.ts";

/**
 * `/harness doctor` (§52).
 *
 * Every check answers a question someone would otherwise have to debug by hand, and
 * every FAIL states the fix. A diagnostic that reports a problem without saying what
 * to do about it has only moved the work.
 *
 * Nothing here prints a secret.
 */

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface Check {
	readonly name: string;
	readonly status: CheckStatus;
	readonly detail: string;
	readonly fix?: string;
}

export interface DoctorArgs {
	readonly paths: HarnessPaths;
	readonly config: HarnessConfig;
	readonly judge: JudgeRouter;
	readonly secret: ResolvedSecret;
	/** Skip everything except Judge reachability — used right after `/harness setup`. */
	readonly onlyJudge?: boolean;
	readonly fetchImpl?: typeof fetch;
}

export async function runDoctor(args: DoctorArgs): Promise<string> {
	const checks: Check[] = args.onlyJudge ? [] : [...environmentChecks(args), ...stateChecks(args), ...secretChecks(args)];
	checks.push(...(await judgeChecks(args)));
	return render(checks);
}

function environmentChecks(args: DoctorArgs): Check[] {
	const checks: Check[] = [];

	// Node version — Pi 0.85.1 requires >= 22.19.0.
	const [major = 0, minor = 0] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10));
	const nodeOk = major > 22 || (major === 22 && minor >= 19);
	checks.push({
		name: "Node runtime",
		status: nodeOk ? "PASS" : "FAIL",
		detail: `Node ${process.versions.node} on ${process.platform}/${process.arch}`,
		...(nodeOk ? {} : { fix: "Pi requires Node >= 22.19.0. Upgrade Node." }),
	});

	// Pi installation and version.
	const pi = findPiPackage();
	if (!pi) {
		checks.push({
			name: "Pi installation",
			status: "WARN",
			detail: "Could not locate the Pi package to read its version.",
			fix: "This is not fatal — the harness is running, so Pi loaded it. Set PI_INSTALL_DIR if you want this check to resolve.",
		});
	} else {
		const supported = isSupportedPiVersion(pi.version);
		checks.push({
			name: "Pi installation",
			status: supported ? "PASS" : "WARN",
			detail: `Pi ${pi.version} at ${displayPath(pi.dir)}`,
			...(supported
				? {}
				: {
						fix: "This harness was built against the Pi 0.85.x extension API. Other versions may have different hooks; run the test suite and check docs/extensions.md.",
					}),
		});
	}

	// Config directory name — proves we are not assuming `.pi`.
	const configDirName = discoverConfigDirName();
	checks.push({
		name: "Config directory",
		status: pathExists(args.paths.configDir) ? "PASS" : "WARN",
		detail: `${displayPath(args.paths.configDir)} (config dir name "${configDirName}", discovered from the installed Pi)`,
		...(pathExists(args.paths.configDir) ? {} : { fix: "Run Pi once so it creates its config directory." }),
	});

	// Extension load path.
	const extensionInstalled = pathExists(`${args.paths.extensionsDir}/pi-universal-harness`);
	checks.push({
		name: "Extension installed",
		status: extensionInstalled ? "PASS" : "WARN",
		detail: extensionInstalled
			? `Present at ${displayPath(args.paths.extensionsDir)}/pi-universal-harness`
			: "Not found in the global extensions directory.",
		...(extensionInstalled
			? {}
			: {
					fix: "If you are running via `pi -e ./index.ts` this is expected. For a global install, run ./scripts/install.sh.",
				}),
	});

	return checks;
}

function stateChecks(args: DoctorArgs): Check[] {
	const checks: Check[] = [];

	const writable = isWritable(args.paths.harnessDir);
	checks.push({
		name: "State directory",
		status: writable ? "PASS" : "FAIL",
		detail: `${displayPath(args.paths.harnessDir)} ${writable ? "is writable" : "is NOT writable"}`,
		...(writable ? {} : { fix: `Fix permissions: chmod u+rwx "${args.paths.harnessDir}"` }),
	});

	checks.push({
		name: "Persistence",
		status: args.config.state.persist ? "PASS" : "WARN",
		detail: args.config.state.persist
			? `Enabled; snapshots every ${args.config.state.snapshotEveryEvents} events`
			: "Disabled in config — state will not survive a Pi restart.",
		...(args.config.state.persist ? {} : { fix: 'Set "state": {"persist": true} in the harness config to keep task history.' }),
	});

	checks.push({
		name: "Harness enabled",
		status: args.config.enabled ? "PASS" : "WARN",
		detail: args.config.enabled ? "The harness is enabled." : "The harness is disabled; no gating is performed.",
		...(args.config.enabled ? {} : { fix: "Run /harness enable, then /reload." }),
	});

	// A fail-open critical policy silently disables the harness's core promise.
	const criticalPolicy = args.config.judge.failurePolicy.critical;
	checks.push({
		name: "Failure policy",
		status: criticalPolicy === "fail_open" ? "WARN" : "PASS",
		detail: `critical=${criticalPolicy}, noncritical=${args.config.judge.failurePolicy.noncritical}`,
		...(criticalPolicy === "fail_open"
			? {
					fix: "critical=fail_open means critical actions proceed unverified whenever the Judge is down. Consider user_review or fail_closed.",
				}
			: {}),
	});

	return checks;
}

function secretChecks(args: DoctorArgs): Check[] {
	const checks: Check[] = [];

	if (args.config.judge.enabled) {
		const configured = args.secret.source !== "none";
		checks.push({
			name: "OpenRouter API key",
			status: configured ? "PASS" : "FAIL",
			detail: configured ? `Configured via ${args.secret.source} (${args.secret.fingerprint})` : "Not configured.",
			...(configured
				? {}
				: { fix: "Run /harness setup, or export OPENROUTER_API_KEY in your shell profile." }),
		});
	} else {
		checks.push({ name: "OpenRouter API key", status: "WARN", detail: "The Judge is disabled, so no key is needed." });
	}

	const permissions = checkPermissions(args.paths);
	if (permissions.exists) {
		checks.push({
			name: "Secret store permissions",
			status: permissions.ok ? "PASS" : "FAIL",
			detail: permissions.message,
			...(permissions.ok ? {} : { fix: `chmod 600 "${args.paths.secretsFile}"` }),
		});
	}

	// The secret store must never be inside a git repository.
	const inRepo = looksLikeGitRepo(args.paths.harnessDir);
	checks.push({
		name: "Secrets isolated from git",
		status: inRepo ? "FAIL" : "PASS",
		detail: inRepo
			? `The harness state directory appears to be inside a git repository: ${displayPath(args.paths.harnessDir)}`
			: "The state directory is outside any git repository.",
		...(inRepo
			? { fix: "Move the harness state out of the repo by setting PI_HARNESS_HOME, and rotate the key if it was ever committed." }
			: {}),
	});

	return checks;
}

async function judgeChecks(args: DoctorArgs): Promise<Check[]> {
	const checks: Check[] = [];
	const { judge: judgeConfig } = args.config;

	if (!judgeConfig.enabled) {
		return [{ name: "Judge", status: "WARN", detail: "The Judge is disabled in configuration; gating falls back to the deterministic engine." }];
	}

	const described = args.judge.describe();
	checks.push({
		name: "Judge configuration",
		status: described.primary ? "PASS" : "WARN",
		detail: `primary=${described.primary ?? "(none)"}, fallbacks=${described.fallbacks.join(" → ") || "(none)"}`,
		...(described.primary ? {} : { fix: 'Set judge.provider to "openrouter" in the harness config.' }),
	});

	if (!args.secret.value) {
		checks.push({
			name: "Judge connectivity",
			status: "FAIL",
			detail: "Skipped — no API key is available.",
			fix: "Run /harness setup or export OPENROUTER_API_KEY.",
		});
		return checks;
	}

	/**
	 * A real call to the decisions endpoint. Querying `/models` would not prove much:
	 * `~typesafe/jev-latest` is a decisions model and is not served from the chat
	 * endpoint, so only an actual decision round trip proves the path works.
	 */
	const endpoint = `${judgeConfig.baseUrl.replace(/\/+$/, "")}${judgeConfig.decisionsPath}`;
	const doFetch = args.fetchImpl ?? fetch;
	const started = Date.now();

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.min(judgeConfig.timeoutMs, 20_000));

		try {
			const response = await doFetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${args.secret.value}`,
					"Content-Type": "application/json",
					"X-Title": "Pi Universal Harness (doctor)",
				},
				body: JSON.stringify({
					model: judgeConfig.model,
					state: "The harness is running a connectivity self-test.",
					questions: {
						healthcheck: {
							type: "noul",
							instructions: "Is this text a self-test message?",
							criteria: { true: "It is a self-test.", false: "It is not a self-test." },
						},
					},
				}),
				signal: controller.signal,
			});

			const latency = Date.now() - started;
			const body = await response.text();

			if (response.ok) {
				let usable = false;
				try {
					const parsed = JSON.parse(body) as { answers?: Record<string, { type?: string; noul?: number }> };
					usable = typeof parsed.answers?.healthcheck?.noul === "number";
				} catch {
					usable = false;
				}

				checks.push({
					name: "Judge connectivity",
					status: usable ? "PASS" : "WARN",
					detail: usable
						? `${judgeConfig.model} answered in ${latency}ms via ${endpoint}`
						: `The endpoint responded in ${latency}ms but the answer was not in the expected shape.`,
					...(usable ? {} : { fix: "The decisions API may have changed shape. Check https://docs.typesafe.ai/api and the adapter in src/judges/openrouter-jev.ts." }),
				});
			} else if (response.status === 401 || response.status === 403) {
				checks.push({
					name: "Judge connectivity",
					status: "FAIL",
					detail: `OpenRouter rejected the key (HTTP ${response.status}).`,
					fix: "The key is invalid or lacks access. Generate a new one at https://openrouter.ai/keys and run /harness setup.",
				});
			} else if (response.status === 404) {
				checks.push({
					name: "Judge connectivity",
					status: "FAIL",
					detail: `HTTP 404 from ${endpoint} for model "${judgeConfig.model}".`,
					fix: "OpenRouter serves Jev from an alpha path that may have moved. Check judge.decisionsPath and judge.model in the harness config.",
				});
			} else {
				checks.push({
					name: "Judge connectivity",
					status: "FAIL",
					detail: `HTTP ${response.status} from ${endpoint}: ${body.slice(0, 200)}`,
					fix: "Check your network and https://status.openrouter.ai.",
				});
			}
		} finally {
			clearTimeout(timer);
		}
	} catch (e) {
		checks.push({
			name: "Judge connectivity",
			status: "FAIL",
			detail: `Could not reach ${endpoint}: ${errorMessage(e)}`,
			fix: "Check network access and any proxy settings. The harness will use its fallback chain until this is resolved.",
		});
	}

	return checks;
}

function render(checks: readonly Check[]): string {
	const lines: string[] = ["Harness doctor", ""];

	for (const check of checks) {
		lines.push(`${check.status.padEnd(4)} ${check.name}`);
		lines.push(`     ${check.detail}`);
		if (check.fix) lines.push(`     → ${check.fix}`);
		lines.push("");
	}

	const failed = checks.filter((c) => c.status === "FAIL").length;
	const warned = checks.filter((c) => c.status === "WARN").length;

	lines.push(
		failed > 0
			? `${failed} failure(s), ${warned} warning(s). The harness will not work correctly until the failures are fixed.`
			: warned > 0
				? `All critical checks passed, with ${warned} warning(s).`
				: "All checks passed.",
	);

	return lines.join("\n");
}

// --- helpers ---

function findPiPackage(): { version: string; dir: string } | undefined {
	const candidates: string[] = [];
	if (process.env.PI_INSTALL_DIR) candidates.push(process.env.PI_INSTALL_DIR);

	try {
		let dir = new URL(".", import.meta.url).pathname;
		for (let i = 0; i < 10; i++) {
			candidates.push(`${dir}node_modules/@earendil-works/pi-coding-agent`);
			const parent = dir.replace(/[^/]+\/$/, "");
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// Ignore.
	}

	const home = process.env.HOME ?? "";
	candidates.push(
		`${home}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`,
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
	);

	for (const dir of candidates) {
		try {
			const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { version?: string; name?: string };
			if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.version) return { version: pkg.version, dir };
		} catch {
			// Next candidate.
		}
	}
	return undefined;
}

/** Built against the 0.85.x extension API; adjacent minors are a warning, not a failure. */
export function isSupportedPiVersion(version: string): boolean {
	const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
	return major === 0 && minor >= 85;
}

function looksLikeGitRepo(dir: string): boolean {
	let current = dir;
	for (let i = 0; i < 10; i++) {
		if (pathExists(`${current}/.git`)) return true;
		const parent = current.replace(/\/[^/]+$/, "");
		if (!parent || parent === current) break;
		current = parent;
	}
	return false;
}
