import { randomUUID } from "node:crypto";

/**
 * Monotonic, sortable, human-scannable identifiers.
 *
 * Event and evidence ids end up in an append-only log that a human reads months
 * later while asking "why did the harness block this?". Lexicographic sort order
 * matching chronological order is worth more here than compactness.
 */

let counter = 0;

const base36 = (n: number, width: number): string => n.toString(36).padStart(width, "0");

/** `ev-01j9x2k4-0007` — time-prefixed and unique within the process. */
export function newId(prefix: string): string {
	counter = (counter + 1) % 0xffff;
	return `${prefix}-${base36(Date.now(), 9)}-${base36(counter, 4)}`;
}

export const newTaskId = (): string => newId("task");
export const newEventId = (): string => newId("ev");
export const newEvidenceId = (): string => newId("evd");
export const newCheckpointId = (): string => newId("ckpt");
export const newDecisionId = (): string => newId("jd");

/** For correlating a single Judge round trip across logs. */
export const newTraceId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();
