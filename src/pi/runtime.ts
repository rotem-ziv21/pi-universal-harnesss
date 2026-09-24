import { join } from "node:path";
import { loadConfig, loadProjectConfig } from "../config/loader.ts";
import { ensureHarnessDirs, type HarnessPaths, resolvePaths } from "../config/paths.ts";
import type { HarnessConfig, ProjectConfig } from "../config/schema.ts";
import { createDecisionLog, type DecisionLog } from "../decide/decision-log.ts";
import { createGates, type Gates } from "../decide/gates.ts";
import { createJevClient, type JevClient } from "../decide/jev.ts";
import { type CredentialHost, createKeyResolver, type KeyResolver, resolveOpenRouterKey, type ResolvedSecret } from "../security/secrets.ts";
import { errorMessage } from "../util/errors.ts";
import { createLogger, type Logger } from "../util/logger.ts";

/**
 * Everything that lives for one Pi session.
 *
 * There is no model here. The harness makes no language-model calls of its own:
 * no contract compiler, no reviewer, no fallback judge built on the session model.
 * That is what makes it indifferent to which model the user picks. The only model
 * it asks is Jev, with fixed questions over observed facts.
 */

export interface HarnessRuntime {
	readonly paths: HarnessPaths;
	readonly config: HarnessConfig;
	readonly projectConfig: ProjectConfig | undefined;
	readonly logger: Logger;
	readonly warnings: readonly string[];
	readonly jev: JevClient;
	readonly gates: Gates;
	readonly decisions: DecisionLog;
	/** Live key resolution, preferring Pi's own credentials. */
	resolveKey(): Promise<ResolvedSecret>;
	/** Pi hands a fresh context on model changes; key lookups go through it. */
	refreshHost(host: RuntimeHost): void;
}

export interface RuntimeHost {
	readonly modelRegistry?: CredentialHost | undefined;
}

export interface RuntimeDeps {
	readonly host: RuntimeHost;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	/** Overridable for tests. */
	readonly fetchImpl?: typeof fetch | undefined;
	readonly paths?: HarnessPaths | undefined;
}

export function createRuntime(deps: RuntimeDeps): HarnessRuntime {
	const paths = deps.paths ?? resolvePaths();
	const warnings: string[] = [];

	let config: HarnessConfig;
	try {
		const loaded = loadConfig(paths);
		config = loaded.config;
		warnings.push(...loaded.warnings);
	} catch (e) {
		warnings.push(`${errorMessage(e)} — running with default configuration.`);
		config = loadConfig({ ...paths, configFile: "/nonexistent" }).config;
	}

	const logger = createLogger({ level: config.logging.level, file: paths.logFile, scope: "harness" });

	try {
		ensureHarnessDirs(paths);
	} catch (e) {
		warnings.push(`${errorMessage(e)} — the decision log is disabled for this session.`);
	}

	const project = loadProjectConfig(deps.cwd, paths.configDirName, deps.projectTrusted);
	warnings.push(...project.warnings);

	let resolveKey: KeyResolver = createKeyResolver({ paths, host: deps.host.modelRegistry });

	const jev = createJevClient({
		config: config.judge,
		getApiKey: async () => (await resolveKey()).value,
		logger,
		...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
	});

	const decisions = createDecisionLog(join(paths.harnessDir, "decisions.jsonl"));

	const gates = createGates({
		config: {
			mode: config.mode,
			action: config.action,
			done: config.done,
			stuckThreshold: config.stuck.repeatThreshold,
		},
		jev,
		log: decisions,
		cwd: deps.cwd,
		protectedPaths: project.config?.protectedPaths,
		extraCheckCommands: Object.values(project.config?.preferredCommands ?? {}),
		logger,
	});

	if (!resolveOpenRouterKey(paths).value && !deps.host.modelRegistry) {
		warnings.push("No OpenRouter key found yet. The Judge needs one: run /login and choose OpenRouter, or /harness setup.");
	}

	return {
		paths,
		config,
		projectConfig: project.config,
		logger,
		warnings,
		jev,
		gates,
		decisions,
		resolveKey: () => resolveKey(),
		refreshHost(host) {
			resolveKey = createKeyResolver({ paths, host: host.modelRegistry });
		},
	};
}
