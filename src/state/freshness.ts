import type { EvidenceRef, FreshnessClass, RecordedAction, VerifiedFact } from "./types.ts";

/**
 * Evidence freshness and contradiction handling (§21, §22).
 *
 * Two rules, and both matter for gate correctness:
 *
 *  1. Old observations are not deleted. They are marked superseded, with a pointer to
 *     what replaced them. `/harness evidence --history` can still show that HTTPS was
 *     unavailable at 14:02 even though it is available now.
 *
 *  2. The Judge is shown *current relevant truth*, not the full contradiction history.
 *     Handing a decision model both "HTTPS unavailable" and "HTTPS available" without
 *     ordering is how you get an incoherent verdict.
 */

export interface FreshnessAssessment {
	readonly fresh: boolean;
	readonly reason: string;
}

export function assessFreshness(
	item: { observedAt: string; stateVersion: number; freshnessClass: FreshnessClass; validity?: string; supersededBy?: string },
	context: { now: number; currentStateVersion: number; changedTargets?: ReadonlySet<string>; worldVersion?: number },
): FreshnessAssessment {
	if (item.supersededBy) {
		return { fresh: false, reason: `superseded by ${item.supersededBy}` };
	}

	switch (item.freshnessClass) {
		case "persistent":
			// A user constraint does not decay. Only the user can change it.
			return { fresh: true, reason: "persistent" };

		case "expiring": {
			if (!item.validity) return { fresh: true, reason: "expiring but no expiry recorded" };
			const expiry = Date.parse(item.validity);
			if (Number.isNaN(expiry)) return { fresh: true, reason: "expiring but expiry unparseable" };
			return expiry > context.now
				? { fresh: true, reason: `valid until ${item.validity}` }
				: { fresh: false, reason: `expired at ${item.validity}` };
		}

		case "until_change": {
			if (!item.validity) return { fresh: true, reason: "valid until its target changes" };
			const changed = context.changedTargets?.has(item.validity) ?? false;
			return changed
				? { fresh: false, reason: `target ${item.validity} changed since observation` }
				: { fresh: true, reason: `target ${item.validity} unchanged` };
		}

		case "temporary": {
			/**
			 * A temporary observation describes the world at one instant. It is treated as
			 * current only while the state it was taken against still stands. Any state
			 * advance means the world may have moved, which is exactly the "decisions from
			 * stale state" failure this harness exists to prevent.
			 *
			 * "The world moved" means an action ran, not that the harness wrote another
			 * line of bookkeeping. Evidence is collected in batches, and each item added
			 * bumps the state version; measured against the raw version, every item but
			 * the last in a batch was stale by the time the gate read it. Reviewer
			 * verdicts vanished, the Judge was asked about conditions already settled, and
			 * completion was rejected for "r2 missing" while r2 sat VERIFIED in the log.
			 * Callers pass `worldVersion` (the last recorded action) for that reason.
			 */
			const horizon = context.worldVersion ?? context.currentStateVersion;
			const stale = item.stateVersion < horizon;
			return stale
				? { fresh: false, reason: `observed at state v${item.stateVersion}, the world moved at v${horizon}` }
				: { fresh: true, reason: `current as of state v${item.stateVersion}` };
		}
	}
}

/**
 * Two observations about the same thing that cannot both be true.
 *
 * Deliberately conservative: it only reports a contradiction when the evidence items
 * describe the same subject (same type and source) and carry different values. It does
 * not attempt semantic contradiction detection across different sources — that is a
 * judgement call, and guessing wrong would silently discard valid evidence.
 */
export function contradicts(older: EvidenceRef, newer: EvidenceRef): boolean {
	if (older.id === newer.id) return false;
	if (older.supersededBy) return false;
	if (older.type !== newer.type) return false;
	if (older.source !== newer.source) return false;
	if (older.freshnessClass === "persistent") return false;
	return older.summary !== newer.summary;
}

/** Mark superseded items in place of deleting them. Returns a new array. */
export function supersede<T extends { id: string; supersededBy?: string; supersededAt?: string }>(
	items: readonly T[],
	supersededIds: ReadonlySet<string>,
	bySuccessorId: string,
	at: string,
): T[] {
	if (supersededIds.size === 0) return [...items];
	return items.map((item) =>
		supersededIds.has(item.id) && !item.supersededBy ? { ...item, supersededBy: bySuccessorId, supersededAt: at } : item,
	);
}

/** Current, non-superseded evidence only. This is what the Judge payload is built from. */
export function currentEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
	return evidence.filter((e) => !e.supersededBy);
}

/** Resource URIs changed by successful mutations at or after an evidence observation. */
export function changedTargetsSince(actions: readonly RecordedAction[], stateVersion: number): ReadonlySet<string> {
	const targets = new Set<string>();
	for (const action of actions) {
		if (action.outcome !== "succeeded" || action.stateVersion < stateVersion) continue;
		for (const effect of action.actionSemantics.effects) {
			if (effect.operation === "read" || effect.operation === "query" || effect.operation === "execute") continue;
			targets.add(effect.uri);
		}
	}
	return targets;
}

/**
 * The state version of the most recent action outcome: the last point at which the
 * workspace could have changed. Temporary evidence observed at or after it is current.
 */
export function worldVersion(actions: readonly RecordedAction[]): number {
	let version = 0;
	for (const action of actions) if (action.stateVersion > version) version = action.stateVersion;
	return version;
}

export function currentFacts(facts: readonly VerifiedFact[]): VerifiedFact[] {
	return facts.filter((f) => !f.supersededBy);
}

/**
 * Evidence bearing on a specific requirement, newest first.
 *
 * Used by the Evidence Planner to decide what is already known, and by the payload
 * builder to include only what is relevant to the checkpoint at hand (§37).
 */
export function evidenceFor(evidence: readonly EvidenceRef[], requirementId: string): EvidenceRef[] {
	return currentEvidence(evidence)
		.filter((e) => e.requirementIds.includes(requirementId))
		.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
}

/** Summarise freshness for the explainability output. */
export function describeFreshness(item: EvidenceRef, currentStateVersion: number): string {
	const assessment = assessFreshness(item, { now: Date.now(), currentStateVersion });
	return assessment.fresh ? `fresh (${assessment.reason})` : `STALE (${assessment.reason})`;
}
