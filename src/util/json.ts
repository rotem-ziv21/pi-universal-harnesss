import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON helpers used across the harness.
 *
 * Two things here are load-bearing:
 *  - `extractJson`, because the Task Compiler must work with *any* model, including
 *    small local ones that wrap JSON in prose or fences;
 *  - `writeJsonAtomic`, because canonical state must never be observed half-written
 *    after a crash.
 */

export function safeParse<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) as T };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Pull the first complete JSON object or array out of arbitrary model output.
 *
 * Handles, in order: a bare JSON document, a ```json fenced block, and a JSON value
 * embedded in prose. Brace counting is string- and escape-aware so that a `}` inside
 * a string literal does not terminate the scan early.
 *
 * This exists because provider-native structured output is not uniformly available
 * across the models the harness must support (§6). Prompt + extract + validate is
 * the portable path.
 */
export function extractJson<T = unknown>(raw: string): { ok: true; value: T } | { ok: false; error: string } {
	const text = raw.trim();
	if (!text) return { ok: false, error: "empty model output" };

	const direct = safeParse<T>(text);
	if (direct.ok) return direct;

	const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/.exec(text);
	if (fence?.[1]) {
		const parsed = safeParse<T>(fence[1].trim());
		if (parsed.ok) return parsed;
	}

	const scanned = scanBalanced(text);
	if (scanned) {
		const parsed = safeParse<T>(scanned);
		if (parsed.ok) return parsed;
	}

	return { ok: false, error: "no parseable JSON document found in model output" };
}

function scanBalanced(text: string): string | undefined {
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	] as const) {
		const start = text.indexOf(open);
		if (start === -1) continue;

		let depth = 0;
		let inString = false;
		let escaped = false;

		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				if (inString) escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth === 0) return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

/** Write via temp file + rename so a reader never sees a truncated document. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Stable stringify — key order independent. Used for action-equivalence hashing. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** Truncate long strings for Judge payloads and log lines, marking the elision. */
export function clamp(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(0, max - 24);
	return `${text.slice(0, keep)}\n…[${text.length - keep} chars elided]`;
}
