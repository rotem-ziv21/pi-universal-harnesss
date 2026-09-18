/**
 * Secret redaction.
 *
 * §32/§57: the API key must never reach a log, a diagnostic dump, a Judge payload,
 * or the terminal. Redaction is applied at the *boundary* — every logger write and
 * every rendered command output passes through here — rather than trusting each
 * call site to remember.
 */

/** Patterns for credentials that commonly appear in tool output and env dumps. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
	/sk-or-v1-[A-Za-z0-9]{16,}/g, // OpenRouter
	/sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
	/sk-proj-[A-Za-z0-9_-]{16,}/g, // OpenAI project
	/sk-[A-Za-z0-9]{32,}/g, // generic OpenAI-style
	/gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
	/AKIA[0-9A-Z]{16}/g, // AWS access key id
	/xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
	/\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

/** `KEY=value` / `KEY: value` for anything that smells like a credential. */
const ASSIGNMENT_PATTERN =
	/\b([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)[A-Z0-9_]*)\s*[=:]\s*(["']?)([^\s"'\n]{6,})\2/gi;

const MASK = "«redacted»";

/** Values registered at runtime (e.g. the key we just loaded) so exact matches die too. */
const known = new Set<string>();

/** Register a literal secret value. Short values are ignored — too likely to be noise. */
export function registerSecret(value: string | undefined): void {
	if (value && value.length >= 8) known.add(value);
}

export function clearRegisteredSecrets(): void {
	known.clear();
}

export function redact(input: string): string {
	let out = input;
	for (const secret of known) {
		if (secret.length >= 8) out = out.split(secret).join(MASK);
	}
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, MASK);
	}
	out = out.replace(ASSIGNMENT_PATTERN, (_m, key: string, quote: string) => `${key}=${quote}${MASK}${quote}`);
	return out;
}

/** Deep-redact an arbitrary value before it is serialized into the event log. */
export function redactValue<T>(value: T): T {
	if (typeof value === "string") return redact(value) as unknown as T;
	if (Array.isArray(value)) return value.map(redactValue) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactValue(v);
		}
		return out as unknown as T;
	}
	return value;
}

/**
 * A stable, non-reversible display form: `sk-or-…f4a2`.
 * Enough to confirm *which* key is loaded without disclosing it.
 */
export function fingerprint(secret: string | undefined): string {
	if (!secret) return "(none)";
	if (secret.length < 12) return "(set, too short to fingerprint)";
	return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}
