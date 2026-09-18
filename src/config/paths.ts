import { accessSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessError } from "../util/errors.ts";

/**
 * Environment discovery.
 *
 * §3 is emphatic: no `/root`, no `/workspace`, no `/Users/<name>`, nothing about the
 * current machine. Every path below is *derived* at runtime, and every step has an
 * explicit override so the harness can be relocated without editing source.
 *
 * Resolution order for the Pi config directory:
 *   1. $PI_HARNESS_CONFIG_DIR  — full override, for exotic setups and tests
 *   2. $PI_CONFIG_DIR          — Pi's own override, if the installation defines one
 *   3. $XDG_CONFIG_HOME/<name> — Linux/RunPod convention when set
 *   4. $HOME/<name>            — the ordinary case on macOS, Linux and containers
 *
 * `<name>` is read from the *installed* Pi package's `piConfig.configDir` rather than
 * hardcoded to `.pi`, because rebranded distributions use a different directory and
 * the docs explicitly warn against assuming it.
 */

export const DEFAULT_CONFIG_DIR_NAME = ".pi";
export const EXTENSION_DIR_NAME = "pi-universal-harness";

export interface HarnessPaths {
	/** e.g. `~/.pi` */
	readonly configDir: string;
	/** e.g. `~/.pi/agent` */
	readonly agentDir: string;
	/** e.g. `~/.pi/agent/extensions` */
	readonly extensionsDir: string;
	/** e.g. `~/.pi/agent/harness` — everything the harness owns lives under here */
	readonly harnessDir: string;
	/** Global harness configuration (no secrets). */
	readonly configFile: string;
	/** Machine-local secrets, mode 0600, never in git. */
	readonly secretsFile: string;
	/** Per-task canonical state and event logs. */
	readonly tasksDir: string;
	/** Pointer to the currently active task for this machine. */
	readonly activeTaskFile: string;
	/** Structured NDJSON diagnostics. */
	readonly logFile: string;
	/** Which name the installed Pi actually uses for its config directory. */
	readonly configDirName: string;
}

/**
 * Ask the *installed* Pi package what its config directory is called.
 * Falls back to `.pi` only when the package cannot be located.
 */
export function discoverConfigDirName(hint?: string): string {
	if (hint) return hint;
	const fromEnv = process.env.PI_CONFIG_DIR_NAME;
	if (fromEnv) return fromEnv;

	for (const pkgPath of candidatePiPackageJsonPaths()) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { piConfig?: { configDir?: string } };
			const name = pkg.piConfig?.configDir;
			if (typeof name === "string" && name.length > 0) return name;
		} catch {
			// Try the next candidate.
		}
	}
	return DEFAULT_CONFIG_DIR_NAME;
}

/**
 * Where the Pi package might live, from most to least authoritative.
 * Starting from `import.meta.url` covers the case where the harness has been
 * installed as a dependency alongside Pi.
 */
function candidatePiPackageJsonPaths(): string[] {
	const out: string[] = [];
	const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "package.json");

	if (process.env.PI_INSTALL_DIR) out.push(join(process.env.PI_INSTALL_DIR, "package.json"));

	try {
		let dir = dirname(new URL(import.meta.url).pathname);
		for (let i = 0; i < 8; i++) {
			out.push(join(dir, rel));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// import.meta.url unavailable — fall through to the global guesses.
	}

	const home = homedir();
	out.push(join(home, ".npm-global", "lib", rel));
	out.push(join("/usr", "local", "lib", rel));
	out.push(join("/usr", "lib", rel));
	if (process.env.NPM_CONFIG_PREFIX) out.push(join(process.env.NPM_CONFIG_PREFIX, "lib", rel));
	return out;
}

export function resolveConfigDir(configDirName: string): string {
	const explicit = process.env.PI_HARNESS_CONFIG_DIR ?? process.env.PI_CONFIG_DIR;
	if (explicit) return resolve(explicit);

	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return resolve(join(xdg, configDirName));

	const home = process.env.HOME ?? homedir();
	if (!home) {
		throw new HarnessError("CONFIG_INVALID", "Cannot resolve a home directory; set PI_HARNESS_CONFIG_DIR explicitly.");
	}
	return resolve(join(home, configDirName));
}

export function resolvePaths(options: { configDirName?: string } = {}): HarnessPaths {
	const configDirName = discoverConfigDirName(options.configDirName);
	const configDir = resolveConfigDir(configDirName);
	const agentDir = join(configDir, "agent");
	const harnessDir = process.env.PI_HARNESS_HOME ? resolve(process.env.PI_HARNESS_HOME) : join(agentDir, "harness");

	return {
		configDir,
		agentDir,
		extensionsDir: join(agentDir, "extensions"),
		harnessDir,
		configFile: join(harnessDir, "config.json"),
		secretsFile: join(harnessDir, "secrets.json"),
		tasksDir: join(harnessDir, "tasks"),
		activeTaskFile: join(harnessDir, "active-task.json"),
		logFile: join(harnessDir, "harness.log"),
		configDirName,
	};
}

export function taskDir(paths: HarnessPaths, taskId: string): string {
	return join(paths.tasksDir, taskId);
}

export interface TaskFiles {
	readonly dir: string;
	readonly events: string;
	readonly state: string;
	readonly contract: string;
}

export function taskFiles(paths: HarnessPaths, taskId: string): TaskFiles {
	const dir = taskDir(paths, taskId);
	return {
		dir,
		events: join(dir, "events.jsonl"),
		state: join(dir, "state.json"),
		contract: join(dir, "contract.json"),
	};
}

/** Create the directories the harness owns. Never touches anything else. */
export function ensureHarnessDirs(paths: HarnessPaths): void {
	try {
		mkdirSync(paths.tasksDir, { recursive: true, mode: 0o700 });
	} catch (e) {
		throw new HarnessError("STATE_DIR_UNWRITABLE", `Cannot create harness state directory at ${paths.tasksDir}`, {
			details: { path: paths.tasksDir },
			cause: e,
		});
	}
}

export function isWritable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export function pathExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Replace a leading home directory with `~` for display.
 * Keeps `/harness status` output free of the operator's username.
 */
export function displayPath(path: string): string {
	const home = process.env.HOME ?? homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
