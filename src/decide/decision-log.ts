import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "../security/redact.ts";

/**
 * Every decision, one JSON line each, outside the model's context.
 *
 * This is what the thresholds get tuned on. Each line carries the state exactly as
 * Jev saw it, the question-pack version, the raw answers, the verdict and the model
 * that answered, so a change to a threshold can be replayed against real traffic
 * instead of being argued about. Secrets are redacted on the way in.
 */

export interface DecisionRecord {
	readonly ts: string;
	readonly kind: "action" | "done" | "stuck";
	readonly mode: "enforce" | "observe";
	readonly questionsVersion: string;
	/** fast | jev | fallback | cap */
	readonly source: string;
	readonly verdict: string;
	readonly reason?: string | undefined;
	readonly summary?: string | undefined;
	readonly state?: unknown;
	readonly answers?: unknown;
	readonly model?: string | undefined;
	readonly latencyMs?: number | undefined;
	readonly error?: string | undefined;
}

export interface DecisionLog {
	write(record: Omit<DecisionRecord, "ts">): DecisionRecord;
	last(): DecisionRecord | undefined;
	tail(count: number): DecisionRecord[];
	readonly path: string;
}

export function createDecisionLog(path: string): DecisionLog {
	let lastRecord: DecisionRecord | undefined;
	let ensured = false;

	return {
		path,
		write(record) {
			const full: DecisionRecord = { ts: new Date().toISOString(), ...record };
			lastRecord = full;
			try {
				if (!ensured) {
					mkdirSync(dirname(path), { recursive: true });
					ensured = true;
				}
				appendFileSync(path, `${JSON.stringify(redactValue(full))}\n`, "utf8");
			} catch {
				// Losing a log line must never affect a decision.
			}
			return full;
		},
		last: () => lastRecord,
		tail(count) {
			try {
				return readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.slice(-count)
					.map((line) => JSON.parse(line) as DecisionRecord);
			} catch {
				return [];
			}
		},
	};
}
