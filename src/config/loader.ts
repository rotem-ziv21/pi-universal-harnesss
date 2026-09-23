import { join } from "node:path";
import { HarnessError } from "../util/errors.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { formatIssues, withDefaults } from "../util/validate.ts";
import { type HarnessConfig, HarnessConfigSchema, type ProjectConfig, ProjectConfigSchema } from "./schema.ts";
import type { HarnessPaths } from "./paths.ts";

/**
 * Config loading.
 *
 * Every field has a schema default, so a missing or empty config file yields a fully
 * valid configuration. That is what makes `git clone && install.sh` enough on a new
 * machine — nothing has to be authored by hand before the harness works.
 */

export interface LoadedConfig {
	readonly config: HarnessConfig;
	/** Non-fatal problems: unknown keys, out-of-range values that were defaulted. */
	readonly warnings: string[];
	readonly source: "file" | "defaults";
}

export function defaultConfig(): HarnessConfig {
	const result = withDefaults<HarnessConfig>(HarnessConfigSchema, {});
	if (!result.ok) {
		// A schema whose own defaults do not validate is a bug, not a user error.
		throw new HarnessError("INTERNAL", `Default harness config is invalid: ${formatIssues(result.issues)}`);
	}
	return result.value;
}

export function loadConfig(paths: HarnessPaths): LoadedConfig {
	const raw = readJsonFile<unknown>(paths.configFile);
	if (raw === undefined) return { config: defaultConfig(), warnings: [], source: "defaults" };

	const warnings: string[] = [];
	if (isRecord(raw) && "judge" in raw && isRecord(raw.judge) && "apiKey" in raw.judge) {
		// Loud, because someone just put a credential somewhere it can be copied.
		warnings.push(
			"config.json contains judge.apiKey — it is ignored. Use OPENROUTER_API_KEY or `/harness setup`, and remove it.",
		);
	}

	const result = withDefaults<HarnessConfig>(HarnessConfigSchema, raw);
	if (!result.ok) {
		throw new HarnessError("CONFIG_INVALID", `Invalid harness config at ${paths.configFile}: ${formatIssues(result.issues)}`, {
			details: { path: paths.configFile, issues: result.issues },
		});
	}
	return { config: result.value, warnings, source: "file" };
}

/** Persist config. Callers pass a full object; partial updates go through `updateConfig`. */
export function saveConfig(paths: HarnessPaths, config: HarnessConfig): void {
	const result = withDefaults<HarnessConfig>(HarnessConfigSchema, config);
	if (!result.ok) {
		throw new HarnessError("CONFIG_INVALID", `Refusing to save invalid config: ${formatIssues(result.issues)}`, {
			details: { issues: result.issues },
		});
	}
	writeJsonAtomic(paths.configFile, result.value);
}

/** Deep-merge a patch into the stored config and save it. Used by `/harness setup`. */
export function updateConfig(paths: HarnessPaths, patch: DeepPartial<HarnessConfig>): HarnessConfig {
	/**
	 * Persist only what the user set. An earlier version merged the patch into the
	 * fully defaulted config and wrote all of it back, which froze every default of
	 * that day into the file: `/harness model` pinned a compiler and, with it,
	 * `maxOutputTokens: 8000`. When the default later rose, the file still won,
	 * and a large contract was cut off at 8k on a machine nobody had tuned.
	 */
	const stored = readJsonFile<unknown>(paths.configFile);
	const base = isRecord(stored) ? stored : {};
	const merged = deepMerge(base, patch as Record<string, unknown>);
	const result = withDefaults<HarnessConfig>(HarnessConfigSchema, merged);
	if (!result.ok) {
		throw new HarnessError("CONFIG_INVALID", `Config update produced an invalid config: ${formatIssues(result.issues)}`, {
			details: { issues: result.issues },
		});
	}
	writeJsonAtomic(paths.configFile, merged);
	return result.value;
}

/**
 * Load `<cwd>/<configDirName>/harness.json` if present.
 *
 * The caller must pass `trusted` from `ctx.isProjectTrusted()`. Project-local config
 * is executable influence over the harness, so it is honoured only for trusted
 * projects — the same rule Pi applies to project-local extensions.
 */
export function loadProjectConfig(
	cwd: string,
	configDirName: string,
	trusted: boolean,
): { config: ProjectConfig | undefined; warnings: string[] } {
	if (!trusted) return { config: undefined, warnings: [] };

	const path = join(cwd, configDirName, "harness.json");
	const raw = readJsonFile<unknown>(path);
	if (raw === undefined) return { config: undefined, warnings: [] };

	const result = withDefaults<ProjectConfig>(ProjectConfigSchema, raw);
	if (!result.ok) {
		return { config: undefined, warnings: [`Ignoring invalid ${path}: ${formatIssues(result.issues)}`] };
	}
	return { config: result.value, warnings: [] };
}

// --- helpers ---

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const existing = out[key];
		out[key] = isRecord(value) && isRecord(existing) ? deepMerge(existing, value) : value;
	}
	return out;
}
