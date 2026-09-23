import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Ground truth for what a command did to the workspace.
 *
 * The harness used to infer a bash command's file effects from its words: which
 * argument looks like a path, which token follows `>`. Every new command shape
 * found a gap in those rules, and each gap was a false block on work that never
 * touched a file. A snapshot of the tree before and after the command replaces
 * inference with observation: the diff is what happened, whatever the command
 * looked like.
 *
 * Bounded so a large repository does not make every tool call expensive: at
 * most `maxEntries` files are indexed, well-known build and VCS directories are
 * skipped, and only small files are hashed (larger ones are compared by size
 * and mtime).
 */

export interface SnapshotEntry {
	readonly size: number;
	readonly mtimeMs: number;
	/** sha1 of the content, for files up to `hashUpTo` bytes. */
	readonly hash?: string;
}

export interface TreeSnapshot {
	readonly root: string;
	readonly entries: ReadonlyMap<string, SnapshotEntry>;
	/** True when the walk stopped at `maxEntries`; the diff is then a lower bound. */
	readonly truncated: boolean;
	readonly takenAt: number;
}

export interface TreeDiff {
	readonly created: readonly string[];
	readonly modified: readonly string[];
	readonly deleted: readonly string[];
	readonly truncated: boolean;
}

export interface SnapshotOptions {
	readonly maxEntries?: number;
	readonly hashUpTo?: number;
	readonly ignore?: readonly string[];
}

const DEFAULT_IGNORE = [".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build", ".next", "target", ".pi"];

export function snapshotTree(root: string, options: SnapshotOptions = {}): TreeSnapshot {
	const maxEntries = options.maxEntries ?? 4000;
	const hashUpTo = options.hashUpTo ?? 256 * 1024;
	const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
	const entries = new Map<string, SnapshotEntry>();
	let truncated = false;

	const walk = (dir: string): void => {
		if (truncated) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			if (ignore.has(name)) continue;
			const full = join(dir, name);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(full);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(full);
				if (truncated) return;
				continue;
			}
			if (!stats.isFile()) continue;
			if (entries.size >= maxEntries) {
				truncated = true;
				return;
			}
			const rel = relative(root, full).split(sep).join("/");
			let hash: string | undefined;
			if (stats.size <= hashUpTo) {
				try {
					hash = createHash("sha1").update(readFileSync(full)).digest("hex").slice(0, 16);
				} catch {
					hash = undefined;
				}
			}
			entries.set(rel, { size: stats.size, mtimeMs: stats.mtimeMs, ...(hash ? { hash } : {}) });
		}
	};

	walk(root);
	return { root, entries, truncated, takenAt: Date.now() };
}

export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): TreeDiff {
	const created: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const [path, entry] of after.entries) {
		const previous = before.entries.get(path);
		if (!previous) {
			created.push(path);
			continue;
		}
		const changed =
			previous.hash !== undefined && entry.hash !== undefined
				? previous.hash !== entry.hash
				: previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs;
		if (changed) modified.push(path);
	}
	for (const path of before.entries.keys()) {
		if (!after.entries.has(path)) deleted.push(path);
	}
	return { created, modified, deleted, truncated: before.truncated || after.truncated };
}

export function isEmptyDiff(diff: TreeDiff): boolean {
	return diff.created.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0;
}

/** One line for a tool result summary, capped so a bulk operation stays readable. */
export function describeDiff(diff: TreeDiff, limit = 12): string {
	const list = (label: string, items: readonly string[]) =>
		items.length === 0 ? undefined : `${label} ${items.slice(0, limit).join(", ")}${items.length > limit ? ` (+${items.length - limit} more)` : ""}`;
	const parts = [list("created", diff.created), list("modified", diff.modified), list("deleted", diff.deleted)].filter(
		(part): part is string => part !== undefined,
	);
	if (parts.length === 0) return "";
	return `[observed in the workspace after the command: ${parts.join("; ")}${diff.truncated ? "; listing truncated" : ""}]`;
}
