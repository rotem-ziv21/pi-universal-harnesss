import type { TaskContract } from "../contract/schema.ts";
import type { HarnessState } from "../state/types.ts";
import { classifyAction } from "../checkpoints/action-semantics.ts";
import type { ProposedAction } from "../checkpoints/types.ts";
import type { ExecFn, ExecResult } from "../evidence/collector.ts";
import { clamp, hashValue } from "../util/json.ts";
import { newId } from "../util/ids.ts";

/**
 * Translation between Pi's world and the harness's world.
 *
 * Everything Pi-shaped lives here and in `extension.ts`. The harness core deals in
 * `ProposedAction` and never sees a Pi event, which is what keeps the pipeline
 * testable without a running agent.
 */

/** Structural view of the Pi `tool_call` event; declared, not imported, for testability. */
export interface PiToolCallEvent {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: Record<string, unknown>;
}

/**
 * Build a tool-agnostic description of a proposed action.
 *
 * The summary is what the Checkpoint Detector matches against contract descriptions
 * and what a human reads in a block message, so it needs to say what the action *does*
 * rather than which tool does it.
 */
export function toProposedAction(
	event: PiToolCallEvent,
	context: { cwd?: string; contract?: TaskContract; state?: HarnessState } = {},
): ProposedAction {
	return {
		id: event.toolCallId || newId("act"),
		toolName: event.toolName,
		input: event.input ?? {},
		actionSemantics: classifyAction(event.toolName, event.input ?? {}, context),
		summary: summarize(event),
		signature: signatureOf(event),
	};
}

/**
 * A one-line description, chosen from the argument shape rather than a per-tool table.
 *
 * A new or custom tool with a `command`, `path` or `url` argument is described as
 * usefully as a built-in one, which matters because the harness must govern tools it
 * has never heard of.
 */
export function summarize(event: PiToolCallEvent): string {
	const input = event.input ?? {};

	const command = firstString(input, ["command", "cmd", "script"]);
	if (command) return `${event.toolName}: ${clamp(command, 200)}`;

	const path = firstString(input, ["path", "file", "filePath", "target", "destination"]);
	if (path) {
		const verb = describeVerb(input);
		return `${event.toolName}: ${verb} ${path}`;
	}

	const url = firstString(input, ["url", "endpoint", "uri"]);
	if (url) return `${event.toolName}: ${clamp(url, 200)}`;

	const query = firstString(input, ["query", "pattern", "prompt", "question", "text"]);
	if (query) return `${event.toolName}: ${clamp(query, 160)}`;

	const keys = Object.keys(input);
	return keys.length > 0 ? `${event.toolName}(${keys.slice(0, 5).join(", ")})` : event.toolName;
}

function describeVerb(input: Record<string, unknown>): string {
	if ("edits" in input || "oldText" in input) return "edit";
	if ("content" in input) return "write";
	if ("offset" in input || "limit" in input) return "read";
	return "access";
}

/**
 * Action equivalence, for loop detection (§43).
 *
 * Volatile fields are excluded so that "the same action" survives an incrementing
 * offset or a fresh id. Two reads of the same file at different offsets are the same
 * *approach*, and treating them as distinct would hide exactly the loop we want to see.
 */
export function signatureOf(event: PiToolCallEvent): string {
	const input = { ...(event.input ?? {}) } as Record<string, unknown>;
	for (const volatile of ["offset", "limit", "timeout", "toolCallId", "id", "timestamp", "cursor"]) {
		delete input[volatile];
	}
	return hashValue({ tool: event.toolName, input });
}

/** Condense a tool result into one line for the event log and the Judge payload. */
export function summarizeResult(content: unknown, isError: boolean): string {
	const text = extractText(content);
	const prefix = isError ? "ERROR: " : "";
	return `${prefix}${clamp(text || "(no output)", 300)}`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	if (content && typeof content === "object") {
		try {
			return JSON.stringify(content);
		} catch {
			return String(content);
		}
	}
	return String(content ?? "");
}

/**
 * Adapt `pi.exec` to the collector's `ExecFn`.
 *
 * Pi's exec signature is close but not identical, and the collector must not depend on
 * Pi being present at all.
 */
export interface PiExecLike {
	exec(
		command: string,
		args: string[],
		options?: { signal?: AbortSignal; cwd?: string },
	): Promise<{ stdout?: string; stderr?: string; exitCode?: number | null; code?: number | null }>;
}

export function createExecFn(pi: PiExecLike): ExecFn {
	return async (command, args, options): Promise<ExecResult> => {
		const result = await pi.exec(command, args, {
			...(options.signal ? { signal: options.signal } : {}),
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? result.code ?? null,
		};
	};
}

/**
 * Does the assistant's final message read as a completion claim?
 *
 * Used only to attach the worker's own words to the completion gate as
 * `agentAssessment`. The gate itself runs on `agent_settled` regardless of what the
 * model said — §44 is explicit that the model must not be able to declare completion
 * and bypass verification, so this is never load-bearing.
 */
export function extractCompletionClaim(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const signals =
		/\b(done|completed?|finished|all set|task is complete|successfully|everything (?:passes|passed|works)|ready to (?:push|ship|deploy)|that should do it)\b/i;

	return signals.test(trimmed) ? clamp(trimmed, 600) : undefined;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}
