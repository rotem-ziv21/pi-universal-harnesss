import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "../security/redact.ts";
import { HarnessError } from "../util/errors.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { HarnessEvent } from "./types.ts";

/**
 * Append-only event log (§19).
 *
 * NDJSON, one event per line, never rewritten. This is the audit trail that answers
 * "why did the harness block this?" months later, and it is the source of truth from
 * which any state snapshot can be rebuilt.
 *
 * Two deliberate choices:
 *  - **Synchronous appends.** An event that is lost because the process died before
 *    an async flush is an event that silently breaks the audit trail. Gate decisions
 *    are low-frequency; correctness beats throughput here.
 *  - **Corruption is survivable.** A truncated final line (power loss mid-write) is
 *    skipped with a warning rather than failing the whole load. Losing one event is
 *    bad; refusing to start is worse.
 */

export interface EventStore {
	append(event: HarnessEvent): void;
	readAll(): HarnessEvent[];
	count(): number;
	readonly path: string;
}

export function createEventStore(path: string, options: { logger?: Logger } = {}): EventStore {
	const log = (options.logger ?? nullLogger).child("events");
	let ensured = false;
	let appended = 0;

	const ensureDir = () => {
		if (ensured) return;
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			ensured = true;
		} catch (e) {
			throw new HarnessError("STATE_DIR_UNWRITABLE", `Cannot create event log directory for ${path}`, { cause: e });
		}
	};

	return {
		path,

		append(event: HarnessEvent): void {
			ensureDir();
			// Redact before serialization: a secret that reaches the log is already leaked.
			const line = JSON.stringify(redactValue(event));
			try {
				appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
				appended++;
			} catch (e) {
				// The audit trail failing must not take Pi down, but it must be loud.
				log.error("failed to append event", { type: event.type, error: e instanceof Error ? e.message : String(e) });
			}
		},

		readAll(): HarnessEvent[] {
			if (!existsSync(path)) return [];
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch (e) {
				throw new HarnessError("EVENT_LOG_CORRUPT", `Cannot read event log at ${path}`, { cause: e });
			}

			const events: HarnessEvent[] = [];
			let skipped = 0;
			const lines = raw.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]?.trim();
				if (!line) continue;
				try {
					const parsed = JSON.parse(line) as HarnessEvent;
					if (parsed && typeof parsed.type === "string" && typeof parsed.stateVersion === "number") {
						events.push(parsed);
					} else {
						skipped++;
					}
				} catch {
					skipped++;
					if (i === lines.length - 1 || i === lines.length - 2) {
						log.warn("ignoring truncated final event (likely an interrupted write)", { path });
					}
				}
			}

			if (skipped > 0) log.warn("skipped unparseable event lines", { path, skipped, kept: events.length });
			return events;
		},

		count(): number {
			return appended;
		},
	};
}

/** In-memory store for tests and for `state.persist: false`. */
export function createMemoryEventStore(): EventStore {
	const events: HarnessEvent[] = [];
	return {
		path: "(memory)",
		append: (event) => void events.push(event),
		readAll: () => [...events],
		count: () => events.length,
	};
}
