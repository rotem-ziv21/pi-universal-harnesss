import { choice, noul, score, type Answer } from "./jev.ts";
import { changedFiles, freshChecks, type RunEvidence } from "./evidence.ts";

/**
 * Pure decision functions. Jev supplies probabilities; these turn them into an
 * outcome. Thresholds live in config, never inside a question, so they can be
 * swept against the decision log without asking Jev anything again.
 *
 * Every message the worker sees is a template filled with facts. No model writes
 * feedback to another model.
 */

// --- actions ---

export interface ActionThresholds {
	readonly destructiveConfirm: number;
	readonly exfiltrationBlock: number;
	readonly outwardConfirm: number;
	readonly offRequestConfirm: number;
}

export type ActionVerdict =
	| { readonly kind: "allow" }
	| { readonly kind: "confirm"; readonly reason: string }
	| { readonly kind: "block"; readonly reason: string };

export function decideAction(answers: Readonly<Record<string, Answer>>, t: ActionThresholds): ActionVerdict {
	const destructive = noul(answers, "destructive");
	const exfiltration = noul(answers, "exfiltration");
	const outward = noul(answers, "outward");
	const offRequest = noul(answers, "off_request");

	if (exfiltration >= t.exfiltrationBlock) return { kind: "block", reason: `it appears to send local data or secrets off this machine (p=${fmt(exfiltration)})` };
	if (destructive >= t.destructiveConfirm) return { kind: "confirm", reason: `it may destroy data that cannot be recovered (p=${fmt(destructive)})` };
	if (outward >= t.outwardConfirm) return { kind: "confirm", reason: `it changes something outside this machine (p=${fmt(outward)})` };
	// Off-request alone is not a hazard; paired with a real effect it is worth a question.
	if (offRequest >= t.offRequestConfirm && (destructive >= 0.3 || outward >= 0.3)) {
		return { kind: "confirm", reason: `it looks unrelated to what you asked for and has effects (p=${fmt(offRequest)})` };
	}
	return { kind: "allow" };
}

/** When Jev cannot answer: pass routine work, hold anything the fast layer flagged. */
export function decideActionWithoutJudge(hints: readonly string[]): ActionVerdict {
	const risky = hints.filter((h) => /outside the workspace|network request|remote|recursive delete|deletes files|substitution|infrastructure|evaluates|not a built-in tool|overwrite|permissions/.test(h));
	if (risky.length === 0) return { kind: "allow" };
	return { kind: "confirm", reason: `the Judge is unavailable and ${risky[0]}` };
}

export function heldMessage(summary: string, reason: string): string {
	return [
		`Harness: held — ${summary}`,
		`Reason: ${reason}.`,
		"Do not retry it unchanged. Either reach the goal with a recoverable alternative that stays inside the project " +
			"(a targeted path, a dry run, a move instead of a delete, a local commit instead of a push), or stop and tell the user " +
			"in one or two sentences what this action does, what cannot be undone, and why it is needed, then wait for their reply.",
	].join("\n");
}

export function deniedMessage(summary: string, reason: string): string {
	return [
		`Harness: blocked — ${summary}`,
		`Reason: ${reason}. This is never run automatically.`,
		"Do not retry it or a variant of it. Tell the user what you were trying to do and let them run it themselves if they want it.",
	].join("\n");
}

// --- completion ---

export interface DoneThresholds {
	readonly claimsDone: number;
	readonly applies: number;
	/** An item's `item_i_done` at or above this counts as carried out. */
	readonly itemDone: number;
	/** At or below this it counts as not carried out; between the two it is uncertain. */
	readonly itemNotDone: number;
	/** `claim_beyond_evidence` at or above this is a claim the evidence does not back. */
	readonly claimBeyond: number;
}

/**
 * What the outcome questions say about the work, counted in code: which
 * requested items the evidence shows, which it does not, which are uncertain,
 * and which were never exercised by a passed check.
 */
export interface OutcomeVerdict {
	readonly status: "verified" | "partial" | "unverified";
	readonly done: readonly string[];
	readonly missing: readonly string[];
	readonly uncertain: readonly string[];
	readonly unchecked: readonly string[];
	readonly claimBeyond: number;
	/** The `completeness` score level, 0..4, when Jev returned one. */
	readonly completeness?: number | undefined;
}

export function judgeOutcome(
	answers: Readonly<Record<string, Answer>>,
	items: readonly string[],
	t: DoneThresholds,
	checksApply: boolean,
): OutcomeVerdict {
	const done: string[] = [];
	const missing: string[] = [];
	const uncertain: string[] = [];
	const unchecked: string[] = [];
	items.forEach((item, i) => {
		const d = noul(answers, `item_${i}_done`);
		const c = noul(answers, `item_${i}_checked`);
		if (d >= t.itemDone) {
			done.push(item);
			if (checksApply && c < t.itemDone) unchecked.push(item);
		} else if (d <= t.itemNotDone) missing.push(item);
		else uncertain.push(item);
	});
	const claimBeyond = noul(answers, "claim_beyond_evidence");
	const completeness = score(answers, "completeness")?.score;
	const status: OutcomeVerdict["status"] =
		items.length > 0 && missing.length === 0 && uncertain.length === 0 && unchecked.length === 0
			? "verified"
			: missing.length === 0 && done.length > 0
				? "partial"
				: "unverified";
	return { status, done, missing, uncertain, unchecked, claimBeyond, completeness };
}

/** One line for the user: what was shown, what was not. */
export function describeOutcome(v: OutcomeVerdict, items: readonly string[]): string {
	const name = (item: string) => `"${item.length > 70 ? `${item.slice(0, 69)}…` : item}"`;
	const list = (label: string, xs: readonly string[]) => (xs.length === 0 ? undefined : `${label}: ${xs.slice(0, 4).map(name).join(", ")}${xs.length > 4 ? ` (+${xs.length - 4} more)` : ""}`);
	const parts = [
		`${v.done.length} of ${items.length} requested item(s) shown by the evidence`,
		list("not shown", v.missing),
		list("uncertain", v.uncertain),
		list("shown but not exercised by a passed check", v.unchecked),
		v.claimBeyond >= 0.7 ? `the final message claims results the evidence does not show (p=${fmt(v.claimBeyond)})` : undefined,
	].filter((p): p is string => p !== undefined);
	return parts.join("; ");
}

/**
 * Whether the stop needs a Judge call at all. No changes, or a check that passed
 * after the last change, settles it without one. That is most stops.
 */
export function needsDoneCheck(evidence: RunEvidence): boolean {
	if (evidence.mutations.length === 0) return false;
	return !freshChecks(evidence).some((c) => c.passed);
}

export type DoneVerdict =
	| { readonly kind: "accept"; readonly why: string }
	| { readonly kind: "nudge"; readonly why: string };

export function decideDone(answers: Readonly<Record<string, Answer>>, t: DoneThresholds): DoneVerdict {
	const claimsDone = noul(answers, "claims_done");
	const applies = noul(answers, "verification_applies");
	const outcome = choice(answers, "outcome");
	// A pick below 0.4 is not a pick.
	const kind = outcome && outcome.p >= 0.4 ? outcome.choice : "other";

	if (kind === "question" || kind === "blocked") return { kind: "accept", why: `the agent stopped to ${kind === "question" ? "ask the user" : "report a blocker"}` };
	if (applies < t.applies) return { kind: "accept", why: `a test or build is not a meaningful check for this task (p=${fmt(applies)})` };
	if (claimsDone < t.claimsDone) return { kind: "accept", why: `the agent does not claim the work is done (p=${fmt(claimsDone)})` };
	return { kind: "nudge", why: `the agent claims the work is done (p=${fmt(claimsDone)}) with no passing check after its last change` };
}

export function doneNudgeMessage(evidence: RunEvidence, claimedVerified: boolean, outcome?: OutcomeVerdict): string {
	const files = changedFiles(evidence);
	const fresh = freshChecks(evidence);
	const freshPass = fresh.some((c) => c.passed);
	const lastFailed = fresh.filter((c) => !c.passed).at(-1);
	const list = files.slice(0, 8).join(", ") + (files.length > 8 ? ` (+${files.length - 8} more)` : "");
	const missing = outcome?.missing ?? [];
	const beyond = outcome !== undefined && outcome.claimBeyond >= 0.7;
	return [
		freshPass
			? `Harness: you report the work as done. You changed ${files.length} file(s) (${list}); a check passed after the last change.`
			: `Harness: you changed ${files.length} file(s) (${list}) and no test, build or check has passed since the last change.`,
		...(missing.length > 0
			? [
					"These requested items are not shown by any changed file, passed check or command output:",
					...missing.slice(0, 6).map((item) => `  - ${item}`),
					...(missing.length > 6 ? [`  (+${missing.length - 6} more)`] : []),
				]
			: []),
		...(lastFailed ? [`The last check after your change failed: \`${lastFailed.command}\` → ${lastFailed.summary}`] : []),
		...(claimedVerified && !freshPass ? ["Your reply says the work was checked, but the harness saw no passing check after the last change."] : []),
		...(beyond ? ["Your reply states results that no tool output shows."] : []),
		missing.length > 0
			? "For each item above: do it, or show it with a tool result (a listing, a test, a run) and report the actual output. " +
				"If an item cannot be done here, say so plainly instead of reporting it as done."
			: "Run the check that applies to this work and report its actual result. " +
				"If no check exists or none can run here, say that plainly in your reply instead of claiming it was verified.",
	].join("\n");
}

const fmt = (p: number): string => p.toFixed(2);
