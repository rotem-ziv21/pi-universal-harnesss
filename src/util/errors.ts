/**
 * Structured errors.
 *
 * Every failure the harness can produce carries a machine-readable `code` so that
 * policy decisions (fail closed? fall back? ask the user?) are made on the code and
 * never on string matching against a message.
 */

export type HarnessErrorCode =
	// configuration / installation
	| "CONFIG_INVALID"
	| "STATE_DIR_UNWRITABLE"
	// contract
	| "CONTRACT_INVALID"
	| "CONTRACT_COMPILE_FAILED"
	| "CONTRACT_LOCKED"
	| "CONTRACT_STALE_REVISION"
	// state
	| "STATE_VERSION_CONFLICT"
	| "EVENT_LOG_CORRUPT"
	// model
	| "MODEL_UNAVAILABLE"
	| "MODEL_OUTPUT_UNPARSEABLE"
	| "MODEL_OUTPUT_INVALID"
	// judge
	| "JUDGE_NOT_CONFIGURED"
	| "JUDGE_AUTH_MISSING"
	| "JUDGE_UNREACHABLE"
	| "JUDGE_TIMEOUT"
	| "JUDGE_RATE_LIMITED"
	| "JUDGE_BAD_RESPONSE"
	| "JUDGE_MODEL_UNAVAILABLE"
	| "JUDGE_STALE_DECISION"
	// evidence
	| "EVIDENCE_COLLECTION_FAILED"
	| "EVIDENCE_SOURCE_UNAVAILABLE"
	// generic
	| "ABORTED"
	| "INTERNAL";

export class HarnessError extends Error {
	readonly code: HarnessErrorCode;
	readonly details: Record<string, unknown>;
	readonly retryable: boolean;

	constructor(
		code: HarnessErrorCode,
		message: string,
		options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
	) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "HarnessError";
		this.code = code;
		this.details = options.details ?? {};
		this.retryable = options.retryable ?? false;
	}

	toJSON(): Record<string, unknown> {
		return { name: this.name, code: this.code, message: this.message, details: this.details, retryable: this.retryable };
	}
}

export const isHarnessError = (e: unknown): e is HarnessError => e instanceof HarnessError;

/** Codes for which a retry could plausibly succeed without any state change. */
export const TRANSIENT_JUDGE_CODES: ReadonlySet<HarnessErrorCode> = new Set([
	"JUDGE_UNREACHABLE",
	"JUDGE_TIMEOUT",
	"JUDGE_RATE_LIMITED",
	"JUDGE_BAD_RESPONSE",
]);

export function errorMessage(e: unknown): string {
	if (isHarnessError(e)) return `[${e.code}] ${e.message}`;
	if (e instanceof Error) return e.message;
	return String(e);
}

/** Never let a harness bug take Pi down with it. */
export async function swallow<T>(fn: () => Promise<T>, onError?: (e: unknown) => void): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e) {
		onError?.(e);
		return undefined;
	}
}
