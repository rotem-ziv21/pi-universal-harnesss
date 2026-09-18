import { HarnessError } from "../util/errors.ts";
import { nowIso } from "../util/ids.ts";
import { stableStringify } from "../util/json.ts";
import type { ContractSource, TaskContract } from "./schema.ts";

/**
 * Contract versioning and locking (§15).
 *
 * Once a contract is locked the worker model may not quietly mutate it. That is not
 * a request to the model — `lock()` freezes the object, and the only legal way
 * forward is `revise()`, which produces a *new* version with a recorded diff, reason
 * and source.
 *
 * This is what makes "the user changed the requirement mid-task" an auditable event
 * rather than a silent drift.
 */

export interface FieldChange {
	readonly field: string;
	readonly change: "added" | "removed" | "modified";
	readonly itemId?: string;
	readonly before?: string;
	readonly after?: string;
}

export interface ContractRevision {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly reason: string;
	readonly source: ContractSource;
	readonly timestamp: string;
	readonly changes: readonly FieldChange[];
}

/**
 * Freeze the contract. Deep-freeze, because a shallow freeze still allows
 * `contract.requirements[0].priority = "soft"`, which is precisely the mutation this
 * is meant to prevent.
 */
export function lock(contract: TaskContract): TaskContract {
	const locked: TaskContract = {
		...contract,
		metadata: { ...contract.metadata, lockedAt: contract.metadata.lockedAt ?? nowIso() },
	};
	return deepFreeze(locked);
}

export function isLocked(contract: TaskContract): boolean {
	return Boolean(contract.metadata.lockedAt);
}

/**
 * Produce the next contract version.
 *
 * `originalRequest` and `id` are carried forward: a revision refines the same task,
 * it does not replace it. A genuinely different task gets a new contract entirely.
 */
export function revise(
	current: TaskContract,
	next: Omit<TaskContract, "id" | "version" | "metadata"> & { metadata?: Partial<TaskContract["metadata"]> },
	options: { reason: string; source: ContractSource },
): { contract: TaskContract; revision: ContractRevision } {
	if (!options.reason.trim()) {
		throw new HarnessError("CONTRACT_INVALID", "A contract revision requires a reason.");
	}

	const revised: TaskContract = {
		...next,
		id: current.id,
		version: current.version + 1,
		metadata: {
			...current.metadata,
			...next.metadata,
			createdAt: current.metadata.createdAt,
			lockedAt: nowIso(),
		},
	};

	const revision: ContractRevision = {
		fromVersion: current.version,
		toVersion: revised.version,
		reason: options.reason,
		source: options.source,
		timestamp: nowIso(),
		changes: diffContracts(current, revised),
	};

	return { contract: deepFreeze(revised), revision };
}

/** Reject a decision or gate computed against a superseded contract version. */
export function assertContractVersion(contract: TaskContract, expectedVersion: number): void {
	if (contract.version !== expectedVersion) {
		throw new HarnessError(
			"CONTRACT_STALE_REVISION",
			`Contract is at version ${contract.version} but version ${expectedVersion} was expected.`,
			{ details: { current: contract.version, expected: expectedVersion } },
		);
	}
}

const ITEM_FIELDS = [
	"requirements",
	"constraints",
	"successConditions",
	"forbiddenConditions",
	"criticalActions",
	"ambiguities",
	"assumptions",
] as const;

/**
 * A field-level diff for the audit trail.
 *
 * Items are matched by id, so a revision that renumbers everything shows up as a
 * wholesale replacement rather than a misleading set of tiny edits.
 */
export function diffContracts(before: TaskContract, after: TaskContract): FieldChange[] {
	const changes: FieldChange[] = [];

	if (before.goal !== after.goal) {
		changes.push({ field: "goal", change: "modified", before: before.goal, after: after.goal });
	}

	for (const field of ITEM_FIELDS) {
		const beforeItems = new Map((before[field] as Array<{ id: string }>).map((i) => [i.id, i]));
		const afterItems = new Map((after[field] as Array<{ id: string }>).map((i) => [i.id, i]));

		for (const [id, item] of afterItems) {
			const prior = beforeItems.get(id);
			if (!prior) {
				changes.push({ field, change: "added", itemId: id, after: describe(item) });
			} else if (stableStringify(prior) !== stableStringify(item)) {
				changes.push({ field, change: "modified", itemId: id, before: describe(prior), after: describe(item) });
			}
		}
		for (const [id, item] of beforeItems) {
			if (!afterItems.has(id)) {
				changes.push({ field, change: "removed", itemId: id, before: describe(item) });
			}
		}
	}

	return changes;
}

/**
 * Universal invariant (§46): a hard user constraint cannot vanish across a revision
 * unless the user themselves asked for it.
 *
 * Returns the offending descriptions so the caller can refuse the revision and show
 * the user exactly what would have been dropped.
 */
export function droppedHardUserItems(before: TaskContract, after: TaskContract): string[] {
	const survives = new Set<string>();
	for (const field of ITEM_FIELDS) {
		for (const item of after[field] as Array<{ description?: string }>) {
			if (item.description) survives.add(normalizeText(item.description));
		}
	}

	const dropped: string[] = [];
	for (const field of ["requirements", "constraints", "successConditions", "forbiddenConditions"] as const) {
		for (const item of before[field] as Array<{ description: string; source: string; priority: string }>) {
			if (item.source !== "user" || item.priority !== "hard") continue;
			if (!survives.has(normalizeText(item.description))) dropped.push(item.description);
		}
	}
	return dropped;
}

const normalizeText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

function describe(item: unknown): string {
	if (item && typeof item === "object" && "description" in item) {
		const obj = item as { description: string; priority?: string; source?: string };
		const tags = [obj.source, obj.priority].filter(Boolean).join("/");
		return tags ? `${obj.description} [${tags}]` : obj.description;
	}
	return stableStringify(item);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const key of Object.getOwnPropertyNames(value)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
	return Object.freeze(value);
}
