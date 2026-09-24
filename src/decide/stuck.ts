import { hashValue } from "../util/json.ts";

/**
 * Repeat-failure detection, without a model.
 *
 * The same call failing the same way several times is an observable fact, not a
 * judgment. The response is a note appended to the tool result the worker is about
 * to read: no block, no extra turn. Each repeat is noted once, so a worker that
 * ignores the note is not lectured on every call.
 */

export interface StuckDetector {
	/** Returns a note to append to the tool result, or undefined. */
	observe(toolName: string, input: Record<string, unknown>, isError: boolean, output: string): string | undefined;
	reset(): void;
}

export function createStuckDetector(options: { threshold: number }): StuckDetector {
	let counts = new Map<string, number>();
	let noted = new Set<string>();

	return {
		observe(toolName, input, isError, output) {
			if (!isError) return undefined;
			const key = hashValue({ tool: toolName, input, error: errorLine(output) });
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			if (count < options.threshold || noted.has(key)) return undefined;
			noted.add(key);
			return (
				`Harness: this exact call has now failed the same way ${count} times (${errorLine(output)}). ` +
				"Repeating it will not help. Read the error, change the command, the code or the environment, " +
				"or tell the user what is blocking you."
			);
		},
		reset() {
			counts = new Map();
			noted = new Set();
		},
	};
}

/** The line that names the failure, stripped of numbers that change between runs. */
function errorLine(output: string): string {
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
	const line = lines.find((l) => /error|fail|denied|not found|no such|cannot|exception/i.test(l)) ?? lines.at(-1) ?? "";
	return line.replace(/\d+(\.\d+)?m?s\b/g, "").slice(0, 160);
}
