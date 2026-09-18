import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "../security/redact.ts";
import { nowIso } from "./ids.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LogRecord {
	ts: string;
	level: Exclude<LogLevel, "silent">;
	scope: string;
	msg: string;
	data?: Record<string, unknown>;
}

export interface Logger {
	debug(msg: string, data?: Record<string, unknown>): void;
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
	child(scope: string): Logger;
}

/**
 * Structured NDJSON logging to a file.
 *
 * Deliberately not stdout: Pi owns the terminal, and an extension writing to it
 * corrupts the TUI. Everything goes to `<stateDir>/harness.log` and is surfaced
 * through `/harness events` and `/harness doctor`.
 *
 * Writes are synchronous and best-effort. A logging failure must never propagate
 * into the gate path — a harness that crashes Pi because its disk is full is worse
 * than a harness that loses a log line.
 */
export function createLogger(options: { level: LogLevel; file?: string; scope?: string }): Logger {
	const threshold = RANK[options.level];
	let ensured = false;

	const write = (level: Exclude<LogLevel, "silent">, scope: string, msg: string, data?: Record<string, unknown>) => {
		if (RANK[level] < threshold) return;
		const record: LogRecord = { ts: nowIso(), level, scope, msg, ...(data ? { data } : {}) };
		let line: string;
		try {
			line = redact(JSON.stringify(record));
		} catch {
			line = JSON.stringify({ ts: nowIso(), level, scope, msg: "<unserializable log record>" });
		}
		if (!options.file) return;
		try {
			if (!ensured) {
				mkdirSync(dirname(options.file), { recursive: true });
				ensured = true;
			}
			appendFileSync(options.file, `${line}\n`, "utf8");
		} catch {
			// Logging must never break the harness.
		}
	};

	const make = (scope: string): Logger => ({
		debug: (m, d) => write("debug", scope, m, d),
		info: (m, d) => write("info", scope, m, d),
		warn: (m, d) => write("warn", scope, m, d),
		error: (m, d) => write("error", scope, m, d),
		child: (sub) => make(`${scope}:${sub}`),
	});

	return make(options.scope ?? "harness");
}

/** For tests and for code paths that run before config is loaded. */
export const nullLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => nullLogger,
};
