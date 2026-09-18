import { chmodSync, statSync, unlinkSync } from "node:fs";
import type { HarnessPaths } from "../config/paths.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { fingerprint, registerSecret } from "./redact.ts";

/**
 * Secret resolution (§32/§33/§34).
 *
 * Strict priority:
 *   1. `OPENROUTER_API_KEY` in the environment
 *   2. the machine-local secret store, mode 0600
 *   3. unavailable — the Judge reports itself as unconfigured
 *
 * Code moves through git; secrets never do. The store lives inside the harness
 * state directory, which is outside the repository by construction.
 */

export const OPENROUTER_ENV_VAR = "OPENROUTER_API_KEY";

export type SecretSource = "env" | "store" | "none";

export interface ResolvedSecret {
	readonly value?: string;
	readonly source: SecretSource;
	/** Safe to print: `sk-or-…f4a2` or `(none)`. */
	readonly fingerprint: string;
}

interface SecretStoreFile {
	version: 1;
	secrets: Record<string, string>;
}

export function resolveOpenRouterKey(paths: HarnessPaths): ResolvedSecret {
	const fromEnv = process.env[OPENROUTER_ENV_VAR]?.trim();
	if (fromEnv) {
		registerSecret(fromEnv);
		return { value: fromEnv, source: "env", fingerprint: fingerprint(fromEnv) };
	}

	const stored = readSecret(paths, OPENROUTER_ENV_VAR);
	if (stored) {
		registerSecret(stored);
		return { value: stored, source: "store", fingerprint: fingerprint(stored) };
	}

	return { source: "none", fingerprint: "(none)" };
}

export function readSecret(paths: HarnessPaths, name: string): string | undefined {
	const file = readJsonFile<SecretStoreFile>(paths.secretsFile);
	const value = file?.secrets?.[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Write a secret to the local store and clamp its permissions to 0600. */
export function writeSecret(paths: HarnessPaths, name: string, value: string): void {
	const existing = readJsonFile<SecretStoreFile>(paths.secretsFile);
	const next: SecretStoreFile = {
		version: 1,
		secrets: { ...(existing?.secrets ?? {}), [name]: value },
	};
	writeJsonAtomic(paths.secretsFile, next);
	hardenPermissions(paths.secretsFile);
	registerSecret(value);
}

export function deleteSecret(paths: HarnessPaths, name: string): boolean {
	const existing = readJsonFile<SecretStoreFile>(paths.secretsFile);
	if (!existing?.secrets || !(name in existing.secrets)) return false;

	delete existing.secrets[name];
	if (Object.keys(existing.secrets).length === 0) {
		try {
			unlinkSync(paths.secretsFile);
		} catch {
			// Already gone.
		}
		return true;
	}
	writeJsonAtomic(paths.secretsFile, existing);
	hardenPermissions(paths.secretsFile);
	return true;
}

/**
 * Enforce 0600 on Unix-like systems. Windows has no equivalent mode, so this is a
 * no-op there rather than a false assurance.
 */
export function hardenPermissions(path: string): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort; `checkPermissions` reports the real state.
	}
}

export interface PermissionCheck {
	readonly exists: boolean;
	readonly ok: boolean;
	readonly mode?: string;
	readonly message: string;
}

/** Used by `/harness doctor` to prove the secret store is not world-readable. */
export function checkPermissions(paths: HarnessPaths): PermissionCheck {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(paths.secretsFile);
	} catch {
		return { exists: false, ok: true, message: "No local secret store (using environment variable or no Judge key)." };
	}

	if (process.platform === "win32") {
		return { exists: true, ok: true, message: "Secret store present. POSIX modes do not apply on Windows." };
	}

	const mode = stats.mode & 0o777;
	const modeStr = mode.toString(8).padStart(3, "0");
	if ((mode & 0o077) !== 0) {
		return {
			exists: true,
			ok: false,
			mode: modeStr,
			message: `Secret store is mode ${modeStr}; it must not be group- or world-accessible. Run: chmod 600 <secrets file>`,
		};
	}
	return { exists: true, ok: true, mode: modeStr, message: `Secret store present, mode ${modeStr}.` };
}
