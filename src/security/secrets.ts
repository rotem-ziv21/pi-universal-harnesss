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

/** Pi's own provider id for OpenRouter, verified against pi-ai's provider table. */
export const OPENROUTER_PROVIDER_ID = "openrouter";

export type SecretSource = "pi" | "env" | "store" | "none";

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

/**
 * Synchronous resolution, for contexts with no access to Pi's registry
 * (`scripts/doctor.sh`'s sibling paths, tests, startup before a session exists).
 */
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

/** The slice of Pi's ModelRegistry we need. Declared so this module compiles without Pi. */
export interface CredentialHost {
	getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export type KeyResolver = () => Promise<ResolvedSecret>;

/**
 * Resolve the OpenRouter key, preferring the one Pi already has.
 *
 * Pi's `/login` stores an OpenRouter API key in its own credential store, and
 * `ModelRegistry.getApiKeyForProvider` resolves that store *and* the environment
 * variable, refreshing OAuth credentials where relevant. Asking Pi is therefore
 * strictly better than maintaining a parallel secret: one place to log in, one place
 * to rotate, and nothing extra to carry between machines.
 *
 * Order:
 *   1. Pi's credential store  — covers `/login` and `OPENROUTER_API_KEY`
 *   2. the environment directly — for when no registry is available yet
 *   3. the harness's own store  — retained for setups that predate this, and for
 *      anyone who would rather not log in to OpenRouter inside Pi
 *   4. unavailable
 *
 * Resolution is **deferred**, not captured once at startup, so a key added with
 * `/login` mid-session takes effect on the very next gate rather than after a reload.
 */
export function createKeyResolver(options: { paths: HarnessPaths; host?: CredentialHost | undefined }): KeyResolver {
	return async (): Promise<ResolvedSecret> => {
		const fromPi = await askPi(options.host);
		if (fromPi) {
			registerSecret(fromPi);
			return { value: fromPi, source: "pi", fingerprint: fingerprint(fromPi) };
		}
		return resolveOpenRouterKey(options.paths);
	};
}

async function askPi(host: CredentialHost | undefined): Promise<string | undefined> {
	if (typeof host?.getApiKeyForProvider !== "function") return undefined;
	try {
		const key = await host.getApiKeyForProvider(OPENROUTER_PROVIDER_ID);
		return key?.trim() || undefined;
	} catch {
		// Pi has no OpenRouter credential, or the lookup failed. Fall through quietly.
		return undefined;
	}
}

/** Human-readable provenance for `/harness status` and `doctor`. */
export function describeSource(source: SecretSource): string {
	switch (source) {
		case "pi":
			return "from Pi's own credentials (/login)";
		case "env":
			return `from ${OPENROUTER_ENV_VAR}`;
		case "store":
			return "from the harness secret store";
		case "none":
			return "not configured";
	}
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
