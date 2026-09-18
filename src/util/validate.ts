import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Thin wrapper over typebox validation.
 *
 * typebox ships with Pi and is one of the imports Pi guarantees to extensions, so
 * using it costs no dependency. Wrapping it here means the rest of the harness never
 * imports a schema library directly and could be moved to Zod or JSON Schema by
 * changing this one file.
 *
 * typebox 1.x reports AJV-shaped errors (`instancePath`, `keyword`, `message`).
 */

export interface ValidationIssue {
	readonly path: string;
	readonly message: string;
	readonly keyword?: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

interface RawIssue {
	instancePath?: string;
	path?: string;
	message?: string;
	keyword?: string;
}

export function validate<T>(schema: TSchema, value: unknown): ValidationResult<T> {
	if (Value.Check(schema, value)) return { ok: true, value: value as T };

	const issues: ValidationIssue[] = [];
	for (const raw of Value.Errors(schema, value) as Iterable<RawIssue>) {
		issues.push({
			path: raw.instancePath ?? raw.path ?? "",
			message: raw.message ?? "invalid value",
			...(raw.keyword ? { keyword: raw.keyword } : {}),
		});
		if (issues.length >= 25) break; // A wall of errors helps nobody.
	}
	if (issues.length === 0) issues.push({ path: "", message: "value does not match schema" });
	return { ok: false, issues };
}

/** Strip unknown properties, then validate. Used on model output, which loves to invent fields. */
export function cleanAndValidate<T>(schema: TSchema, value: unknown): ValidationResult<T> {
	let cleaned = value;
	try {
		cleaned = Value.Clean(schema, structuredClone(value));
	} catch {
		// Non-cloneable input: validate what we were given.
	}
	return validate<T>(schema, cleaned);
}

/** Apply schema defaults where properties are missing, then validate. */
export function withDefaults<T>(schema: TSchema, value: unknown): ValidationResult<T> {
	let prepared = value;
	try {
		prepared = Value.Default(schema, structuredClone(value ?? {}));
	} catch {
		// Fall through and validate as-is.
	}
	return validate<T>(schema, prepared);
}

/** One-line, human-readable rendering for error messages and repair prompts. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
	return issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; ");
}
