import { choice, noul, type Answer } from "./jev.ts";
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

export function doneNudgeMessage(evidence: RunEvidence, claimedVerified: boolean): string {
	const files = changedFiles(evidence);
	const fresh = freshChecks(evidence);
	const lastFailed = fresh.filter((c) => !c.passed).at(-1);
	const list = files.slice(0, 8).join(", ") + (files.length > 8 ? ` (+${files.length - 8} more)` : "");
	return [
		`Harness: you changed ${files.length} file(s) (${list}) and no test, build or check has passed since the last change.`,
		...(lastFailed ? [`The last check after your change failed: \`${lastFailed.command}\` → ${lastFailed.summary}`] : []),
		...(claimedVerified ? ["Your reply says the work was checked, but the harness saw no passing check after the last change."] : []),
		"Run the check that applies to this work and report its actual result. " +
			"If no check exists or none can run here, say that plainly in your reply instead of claiming it was verified.",
	].join("\n");
}

const fmt = (p: number): string => p.toFixed(2);
