import { isCheckCommand, splitCommand, tokenize } from "./hazards.ts";

/**
 * What the worker actually did, as the runtime saw it.
 *
 * Nothing here comes from a model. A mutation is a write or edit tool call, or a
 * shell command after which the workspace snapshot differs. A check is a test,
 * build, typecheck or lint command, and whether it passed is read from the tool
 * result (Pi reports a nonzero exit as an error) and the runner's own summary.
 *
 * The completion decision rests on one ordering fact: did a check pass *after* the
 * last change? That is observable, it is the same whatever model did the work, and
 * it is what "verified" means for code.
 */

export interface Mutation {
	readonly seq: number;
	readonly tool: string;
	readonly paths: readonly string[];
}

export interface Check {
	readonly seq: number;
	readonly command: string;
	readonly passed: boolean;
	/** The runner's summary line or the last line of output, for the message and the log. */
	readonly summary: string;
}

/** A command that is neither a check nor a change: what it printed is still evidence (curl, ls, cat, node -e). */
export interface Observation {
	readonly seq: number;
	readonly command: string;
	readonly ok: boolean;
	readonly summary: string;
}

export interface RunEvidence {
	readonly mutations: readonly Mutation[];
	readonly checks: readonly Check[];
	readonly observations: readonly Observation[];
}

const MAX_OBSERVATIONS = 40;

export interface ToolOutcome {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly isError: boolean;
	readonly output: string;
	/** Files the snapshot saw change, for shell and unknown tools. */
	readonly changed?: readonly string[] | undefined;
}

export interface EvidenceTracker {
	record(outcome: ToolOutcome): void;
	get(): RunEvidence;
	reset(): void;
}

export function createEvidenceTracker(options: { extraCheckCommands?: readonly string[] } = {}): EvidenceTracker {
	let seq = 0;
	let mutations: Mutation[] = [];
	let checks: Check[] = [];
	let observations: Observation[] = [];
	const extra = (options.extraCheckCommands ?? []).map(normalize).filter(Boolean);

	return {
		record(outcome) {
			seq++;
			const tool = outcome.toolName.toLowerCase();

			if (tool === "write" || tool === "edit") {
				if (outcome.isError) return;
				const path = typeof outcome.input.path === "string" ? outcome.input.path : typeof outcome.input.file_path === "string" ? outcome.input.file_path : "(unknown)";
				mutations.push({ seq, tool, paths: [path] });
				return;
			}

			const command = typeof outcome.input.command === "string" ? outcome.input.command : undefined;
			if (command && isCheck(command, extra)) {
				// A check's own byproducts (coverage files, build output) are not new work.
				checks.push({ seq, command: clip(command, 200), passed: !outcome.isError && !reportsFailure(outcome.output), summary: summaryLine(outcome.output) });
				return;
			}

			if (outcome.changed && outcome.changed.length > 0) {
				mutations.push({ seq, tool, paths: outcome.changed.slice(0, 50) });
			}
			if (command) {
				observations.push({ seq, command: clip(command, 200), ok: !outcome.isError, summary: observationSummary(outcome.output) });
				if (observations.length > MAX_OBSERVATIONS) observations = observations.slice(-MAX_OBSERVATIONS);
			}
		},
		get: () => ({ mutations, checks, observations }),
		reset() {
			mutations = [];
			checks = [];
			observations = [];
		},
	};
}

/** Checks that ran after the last mutation. Only these say anything about the current state. */
export function freshChecks(evidence: RunEvidence): Check[] {
	const last = evidence.mutations.at(-1)?.seq ?? 0;
	return evidence.checks.filter((c) => c.seq > last);
}

export function changedFiles(evidence: RunEvidence): string[] {
	return [...new Set(evidence.mutations.flatMap((m) => m.paths))];
}

function isCheck(command: string, extra: readonly string[]): boolean {
	const normalized = normalize(command);
	if (extra.some((e) => normalized.includes(e))) return true;
	return splitCommand(command).some((segment) => {
		const argv = tokenize(segment).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
		return isCheckCommand(argv);
	});
}

/**
 * A runner can exit zero and still report failures (a wrapper script, `|| true`,
 * a pipe into `tail`). Read the summary the common runners print.
 */
export function reportsFailure(output: string): boolean {
	const text = output.slice(-6000);
	return (
		/\b[1-9]\d* (failed|failing|failures?|errors?)\b/i.test(text) ||
		/\bTests?:\s+[1-9]\d* failed/i.test(text) ||
		/^FAIL\b/m.test(text) ||
		/\berror TS\d+:/.test(text) ||
		/^(FAILED|ERROR)\b/m.test(text) ||
		/test result: FAILED/.test(text) ||
		/^--- FAIL:/m.test(text) ||
		/\bBUILD FAILED\b/.test(text) ||
		/^✖ [1-9]\d* problems?/m.test(text)
	);
}

function summaryLine(output: string): string {
	const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
	const summary = [...lines].reverse().find((l) => /\b(pass|passed|passing|fail|failed|failing|error|errors|tests?|ok)\b/i.test(l));
	return clip(summary ?? lines.at(-1) ?? "(no output)", 200);
}

/** The first and last lines of what a command printed: enough to see a status code, a listing, a count. */
function observationSummary(output: string): string {
	const lines = output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "(no output)";
	if (lines.length <= 4) return clip(lines.join(" | "), 300);
	return clip([...lines.slice(0, 2), "…", ...lines.slice(-2)].join(" | "), 300);
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
