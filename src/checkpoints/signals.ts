import type { TaskContract } from "../contract/schema.ts";
import type { CheckpointSignal, ProposedAction } from "./types.ts";

/**
 * Signal extraction.
 *
 * Two families, kept strictly apart:
 *
 *   **Contract signals** are exact. The contract says "publish the repository changes
 *   is a critical action"; the proposed action resembles that description; gate. No
 *   heuristic, no guessing, weight 1.
 *
 *   **Generic signals** are a documented safety net for actions the contract never
 *   anticipated. They are deliberately biased toward over-gating, and they describe
 *   *effects on the world* rather than tools.
 *
 * §68 forbids undocumented heuristics, so every generic signal below states exactly
 * what it looks for and why. Note what is absent: no `if (command === "git push")`.
 * The word "git" does not appear in this file.
 */

// --- contract-derived signals (exact) ---

/**
 * Match a proposed action against the contract's declared critical actions.
 *
 * Matching is lexical overlap between the action's description and the contract's.
 * It is intentionally generous: a missed critical action is a governance failure,
 * while a spurious gate costs one Judge call. Genuinely ambiguous cases fall through
 * to Judge escalation, which handles semantics properly.
 */
export function contractCriticalActionSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const haystack = actionText(action);
	const signals: CheckpointSignal[] = [];

	for (const critical of contract.criticalActions) {
		const score = overlapScore(critical.description, haystack);
		if (score >= 0.34) {
			signals.push({
				type: "contract_critical_action",
				reason: `The Task Contract marks this as a critical action: "${critical.description}"`,
				origin: "contract",
				weight: 1,
				relatedItemIds: [critical.id, ...critical.requiresVerificationOf],
			});
		}
	}
	return signals;
}

/**
 * Flag actions that could touch something a hard constraint protects.
 *
 * Only hard constraints produce signals. A soft preference is not worth a gate — the
 * Judge would be asked to adjudicate something the user already said was negotiable.
 */
export function constraintRiskSignals(contract: TaskContract, action: ProposedAction): CheckpointSignal[] {
	const signals: CheckpointSignal[] = [];
	const haystack = actionText(action);
	const paths = extractPathLikeTokens(action);

	for (const constraint of contract.constraints) {
		if (constraint.priority !== "hard") continue;

		// A machine-checkable constraint naming a path we are about to touch: exact hit.
		if (constraint.check && paths.some((p) => pathsOverlap(p, constraint.check!.target))) {
			signals.push({
				type: "constraint_risk",
				reason: `This action touches "${constraint.check.target}", which a hard constraint protects: "${constraint.description}"`,
				origin: "contract",
				weight: 1,
				relatedItemIds: [constraint.id],
			});
			continue;
		}

		if (!isMutating(action)) continue;

		const score = overlapScore(constraint.description, haystack);
		if (score >= 0.4) {
			signals.push({
				type: "constraint_risk",
				reason: `This action may bear on a hard constraint: "${constraint.description}"`,
				origin: "contract",
				weight: 0.8,
				relatedItemIds: [constraint.id],
			});
		}
	}

	for (const forbidden of contract.forbiddenConditions) {
		if (forbidden.priority !== "hard" || !isMutating(action)) continue;
		if (overlapScore(forbidden.description, haystack) >= 0.4) {
			signals.push({
				type: "constraint_risk",
				reason: `This action may lead to a forbidden condition: "${forbidden.description}"`,
				origin: "contract",
				weight: 0.7,
				relatedItemIds: [forbidden.id],
			});
		}
	}

	return signals;
}

// --- generic signals (documented heuristics) ---

/**
 * Does this action change state outside this machine, or state other people can see?
 *
 * Detected by the presence of a remote destination in the action's arguments: a URL
 * with a non-loopback host, or a verb of transmission applied to a named remote. This
 * is about *reach*, not about which tool is used.
 */
export function externalMutationSignal(action: ProposedAction): CheckpointSignal | undefined {
	if (!isMutating(action)) return undefined;
	const text = actionText(action);

	const remoteUrl = /\bhttps?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[\w.-]+/i.exec(text);
	if (remoteUrl) {
		return {
			type: "external_mutation",
			reason: `This action sends data to a remote destination (${remoteUrl[0].slice(0, 60)}).`,
			origin: "generic",
			weight: 0.8,
			relatedItemIds: [],
		};
	}

	// Transmission verbs: publishing, uploading, deploying, sending, releasing.
	if (/\b(push|publish|upload|deploy|release|send|submit|post|sync|ship)\b/i.test(text)) {
		return {
			type: "external_mutation",
			reason: "This action appears to transmit or publish state beyond the local workspace.",
			origin: "generic",
			weight: 0.65,
			relatedItemIds: [],
		};
	}
	return undefined;
}

/**
 * Does this action destroy or overwrite existing data?
 *
 * Detected by removal/overwrite verbs combined with a target, or by recursive-force
 * flag patterns that are conventional across many CLIs (`-rf`, `--force`, `--hard`).
 */
export function destructiveSignal(action: ProposedAction): CheckpointSignal | undefined {
	const text = actionText(action);

	if (REMOVAL_PROGRAMS.test(text)) {
		return {
			type: "destructive",
			reason: "This action invokes a removal command.",
			origin: "generic",
			weight: 0.85,
			relatedItemIds: [],
		};
	}

	// Force / recursive flags, which turn an ordinary operation into an unrecoverable one.
	if (FORCE_FLAGS.test(text)) {
		return {
			type: "destructive",
			reason: "This action uses a forced or recursive flag, which removes the usual safety checks.",
			origin: "generic",
			weight: 0.85,
			relatedItemIds: [],
		};
	}

	// English verbs of destruction, for tools and APIs rather than shell commands.
	if (DESTRUCTIVE_VERBS.test(text)) {
		return {
			type: "destructive",
			reason: "This action appears to delete or overwrite existing data.",
			origin: "generic",
			weight: 0.8,
			relatedItemIds: [],
		};
	}
	return undefined;
}

/**
 * Is this action irreversible from inside the task?
 *
 * Distinct from destructive: an action can be non-destructive yet unrecoverable, such
 * as sending a message or charging a card. Detected by verbs of commitment applied to
 * an external party.
 */
export function irreversibleSignal(action: ProposedAction): CheckpointSignal | undefined {
	const text = actionText(action);
	if (/\b(charge|refund|pay|invoice|email|notify|announce|broadcast|merge|tag|revoke|rotate|terminate|shutdown)\b/i.test(text)) {
		return {
			type: "irreversible",
			reason: "This action commits to something that cannot be undone from within the task.",
			origin: "generic",
			weight: 0.6,
			relatedItemIds: [],
		};
	}
	return undefined;
}

/** A project marking a path as protected is configuration, not a guess: weight 1. */
export function protectedPathSignals(protectedPaths: readonly string[], action: ProposedAction): CheckpointSignal[] {
	if (!isMutating(action)) return [];
	const touched = extractPathLikeTokens(action);
	const signals: CheckpointSignal[] = [];

	for (const protectedPath of protectedPaths) {
		if (touched.some((p) => pathsOverlap(p, protectedPath))) {
			signals.push({
				type: "constraint_risk",
				reason: `This action touches "${protectedPath}", which project configuration marks as protected.`,
				origin: "project",
				weight: 1,
				relatedItemIds: [],
			});
		}
	}
	return signals;
}

// --- shared vocabulary ---

/**
 * Removal programs, by name.
 *
 * Matched separately from the English verbs because a removal command frequently
 * contains no verb a human would recognise — `rm -f -- ./*.log` says "delete" nowhere.
 *
 * This list exists because of a real gap found during a live run: `find … -delete` was
 * correctly blocked, and the model then reached the identical outcome with
 * `rm -f -- ./*.log`, which matched nothing. A gate that can be defeated by rephrasing
 * is a vocabulary filter, not a gate.
 */
const REMOVAL_PROGRAMS = /\b(rm|rmdir|unlink|shred|srm)\b/i;

/** Flags that strip the usual safety checks off an otherwise ordinary operation. */
const FORCE_FLAGS = /(^|\s)-{1,2}(r?f|fr|force|hard|recursive|no-preserve-root)\b/i;

/**
 * Verbs of destruction, for tools and APIs rather than shell programs.
 *
 * `prune` carries a negative lookbehind for `-`, because `find … -prune -o …` is one
 * of the most common read-only search idioms there is, while `git prune` and
 * `docker system prune` really do destroy things. Gating every `find` that skips a
 * directory would make the harness insufferable, and a harness people route around
 * governs nothing.
 *
 * Note that `-delete` deliberately has no such exemption: `find … -delete` is exactly
 * as destructive as it looks.
 */
const DESTRUCTIVE_VERBS = /\b(delete|destroy|drop|truncate|wipe|erase|overwrite|reset|revert|discard)\b|\bpurge\b|(?<!-)\bprune\b/i;

/**
 * Anything destructive, in any form.
 *
 * `isMutating` and `destructiveSignal` must agree on this. When they drifted apart,
 * `unlink` and `shred` were classified as read-only and never reached the detector at
 * all — the fast path swallowed them before any signal could fire. One definition,
 * used by both, makes that class of bug unrepresentable.
 */
const ANY_DESTRUCTIVE = new RegExp(`${REMOVAL_PROGRAMS.source}|${DESTRUCTIVE_VERBS.source}`, "i");

// --- shared helpers ---

/**
 * Does this action change anything, or only observe?
 *
 * Read-only actions take the fast path and never reach the Judge, which is what keeps
 * the harness affordable. Determined from the argument shape, not a tool allowlist:
 * an action with no write-like verb and no content payload is treated as a read.
 */
export function isMutating(action: ProposedAction): boolean {
	const text = actionText(action);

	// A payload of new content is the clearest sign of a write.
	for (const key of ["content", "newText", "edits", "data", "body", "patch", "replacement"]) {
		if (key in action.input && action.input[key] !== undefined) return true;
	}

	if (/\b(write|create|edit|modify|update|set|add|insert|append|install|move|copy|rename|chmod|chown|mkdir|touch)\b/i.test(text)) {
		return true;
	}
	if (ANY_DESTRUCTIVE.test(text) || /\b(push|publish|upload|deploy|release|send|submit|post)\b/i.test(text)) return true;

	// Shell redirection and in-place editing.
	if (/(^|\s)>{1,2}\s*\S/.test(text) || /\bsed\s+-i\b/.test(text) || /\btee\b/.test(text)) return true;

	return false;
}

/** Everything about the action a signal might match against, as one lowercase string. */
export function actionText(action: ProposedAction): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(action.input);
	} catch {
		serialized = String(action.input);
	}
	return `${action.toolName} ${action.summary} ${serialized}`.toLowerCase();
}

/** Path-like strings in the arguments, for constraint and protected-path matching. */
export function extractPathLikeTokens(action: ProposedAction): string[] {
	const out = new Set<string>();

	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (/[/\\]/.test(value) || /\.\w{1,6}$/.test(value)) {
				for (const token of value.split(/\s+/)) {
					const cleaned = token.replace(/^['"]|['",;:]$/g, "");
					if (cleaned.length > 1 && (/[/\\]/.test(cleaned) || /\.\w{1,6}$/.test(cleaned))) out.add(cleaned);
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const v of value) visit(v);
			return;
		}
		if (value && typeof value === "object") {
			for (const v of Object.values(value)) visit(v);
		}
	};

	visit(action.input);
	return [...out];
}

/**
 * Do two path expressions plausibly refer to the same thing?
 *
 * Containment in either direction, after normalization. Glob-ish protected paths such
 * as `src/frontend/**` are reduced to their literal prefix.
 */
export function pathsOverlap(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (!na || !nb) return false;
	return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`) || na.includes(nb) || nb.includes(na);
}

function normalizePath(p: string): string {
	return p
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/\\/g, "/")
		.replace(/\/?\*+.*$/, "")
		.replace(/^\.\//, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

const STOP_WORDS = new Set([
	"the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "is", "are", "be", "must", "not", "do", "does",
	"any", "all", "with", "that", "this", "it", "its", "from", "at", "by", "as", "into", "then", "only", "if",
	"should", "will", "shall", "can", "may",
]);

/**
 * Lexical overlap between a contract description and an action.
 *
 * Returns the fraction of the description's content words that appear in the action
 * text. Crude on purpose: it is a *trigger* for gating, not a verdict. Semantics are
 * the Judge's job, and ambiguous cases escalate there.
 */
export function overlapScore(description: string, haystack: string): number {
	const words = tokenize(description);
	if (words.length === 0) return 0;
	let hits = 0;
	for (const word of words) {
		if (haystack.includes(word)) hits++;
	}
	return hits / words.length;
}

function tokenize(text: string): string[] {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
		const word = raw.replace(/^[-.]+|[-.]+$/g, "");
		if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
	}
	return [...out];
}
