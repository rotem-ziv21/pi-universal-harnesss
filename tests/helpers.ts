import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposedAction } from "../src/checkpoints/types.ts";
import { defaultConfig } from "../src/config/loader.ts";
import type { HarnessPaths } from "../src/config/paths.ts";
import type { HarnessConfig } from "../src/config/schema.ts";
import type { TaskContract } from "../src/contract/schema.ts";
import type { AssessQuery, Judge, JudgeDecision, JudgeQuery, JudgeStats } from "../src/judges/judge.ts";
import { emptyStats } from "../src/judges/judge.ts";
import { hashValue } from "../src/util/json.ts";

/** Shared fixtures. Nothing here touches the real Pi config directory. */

export function tempPaths(): HarnessPaths & { cleanup(): void } {
	const root = mkdtempSync(join(tmpdir(), "harness-test-"));
	const harnessDir = join(root, "harness");

	return {
		configDir: root,
		agentDir: join(root, "agent"),
		extensionsDir: join(root, "agent", "extensions"),
		harnessDir,
		configFile: join(harnessDir, "config.json"),
		secretsFile: join(harnessDir, "secrets.json"),
		tasksDir: join(harnessDir, "tasks"),
		activeTaskFile: join(harnessDir, "active-task.json"),
		logFile: join(harnessDir, "harness.log"),
		configDirName: ".pi",
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export function testConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	return { ...defaultConfig(), ...overrides };
}

export function action(toolName: string, input: Record<string, unknown>, summary?: string): ProposedAction {
	return {
		id: `act-${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		input,
		summary: summary ?? `${toolName} ${JSON.stringify(input).slice(0, 80)}`,
		signature: hashValue({ tool: toolName, input }),
	};
}

/**
 * A minimal but structurally complete contract.
 *
 * Tests build on this rather than on a fixture from one domain, so that no test
 * accidentally encodes an assumption that only holds for, say, coding tasks.
 */
export function contract(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id: "task-test",
		version: 1,
		originalRequest: "test request",
		goal: "test goal",
		requirements: [],
		constraints: [],
		successConditions: [],
		forbiddenConditions: [],
		criticalActions: [],
		ambiguities: [],
		assumptions: [],
		metadata: { createdAt: new Date().toISOString() },
		...overrides,
	};
}

/** A Judge that returns exactly what a test tells it to. */
export function scriptedJudge(
	responder: (query: JudgeQuery) => Partial<JudgeDecision>,
	options: { id?: string; available?: boolean; assess?: number } = {},
): Judge & { calls: JudgeQuery[] } {
	const calls: JudgeQuery[] = [];
	let stats: JudgeStats = emptyStats();

	return {
		id: options.id ?? "scripted",
		calls,
		async isAvailable() {
			return options.available !== false;
		},
		async evaluate(query) {
			calls.push(query);
			stats = { ...stats, calls: stats.calls + 1 };
			const partial = responder(query);
			return {
				decision: "PASS",
				confidence: 0.9,
				reasons: [],
				missingEvidence: [],
				stateVersion: query.stateVersion,
				judgeId: options.id ?? "scripted",
				...partial,
			};
		},
		async assess() {
			stats = { ...stats, calls: stats.calls + 1 };
			return options.assess ?? 0;
		},
		stats: () => stats,
	};
}

/** A Judge that always throws, for failure-policy tests. */
export function brokenJudge(error: Error, id = "broken"): Judge {
	return {
		id,
		async isAvailable() {
			return true;
		},
		async evaluate() {
			throw error;
		},
		async assess() {
			throw error;
		},
		stats: () => emptyStats(),
	};
}

/** Build a `fetch` that returns canned decisions-endpoint responses. */
export function fakeFetch(
	handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof fetch & { calls: Array<{ url: string; body: unknown }> } {
	const calls: Array<{ url: string; body: unknown }> = [];

	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body: parsedBody });

		const result = handler(url, init ?? {});
		const status = result.status ?? 200;

		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				return result.body;
			},
			async text() {
				return typeof result.body === "string" ? result.body : JSON.stringify(result.body);
			},
		} as Response;
	}) as typeof fetch & { calls: Array<{ url: string; body: unknown }> };

	impl.calls = calls;
	return impl;
}

export const noulAnswer = (value: number) => ({ type: "noul", noul: value });

export const choiceAnswer = (choice: string, probabilities: Record<string, number>, confidence: number) => ({
	type: "choice",
	choice,
	probabilities,
	confidence,
});
