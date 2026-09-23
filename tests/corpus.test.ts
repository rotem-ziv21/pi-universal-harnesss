import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createCheckpointDetector } from "../src/checkpoints/detector.ts";
import { toProposedAction } from "../src/pi/pi-adapter.ts";
import { createStateManager } from "../src/state/state-manager.ts";
import { contract, testConfig } from "./helpers.ts";

/**
 * The corpus: commands from live runs, replayed through the classifier and the
 * detector against a generic contract (no compiler-written policies), so that
 * every false block found in the field stays fixed, and every dangerous command
 * stays stopped. The tests elsewhere use scripted models; this file is what a
 * real worker actually typed.
 */
interface Entry {
	tool: string;
	command?: string;
	input?: Record<string, unknown>;
	expect: "allow" | "gate" | "block";
	from: string;
}

const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "corpus", "commands.json"), "utf8")) as { entries: Entry[] };
const CWD = "/workspace/shorty4";

describe("Command corpus from live runs", () => {
	for (const entry of corpus.entries) {
		const label = entry.command ?? JSON.stringify(entry.input);
		test(`${entry.expect}: ${label.slice(0, 70).replace(/\n/g, "⏎")}  [${entry.from}]`, async () => {
			const c = contract({ metadata: { createdAt: new Date().toISOString(), cwd: CWD } });
			const state = createStateManager(c.id, c, { persist: false });
			state.lockContract(c);
			const config = testConfig();
			const detector = createCheckpointDetector({ config });
			const input = entry.input ?? { command: entry.command };
			const action = toProposedAction(
				{ toolName: entry.tool, toolCallId: `corpus-${Math.random().toString(36).slice(2, 8)}`, input },
				{ cwd: CWD, contract: c, state: state.getState() },
			);
			const decision = await detector.evaluate({ contract: c, state: state.getState(), action });
			const outcome = decision.policyDecision === "block" ? "block" : decision.needsGate ? "gate" : "allow";
			assert.equal(
				outcome,
				entry.expect,
				`expected ${entry.expect}, got ${outcome}: ${decision.reason}; effects: ${action.actionSemantics.effects.map((e) => `${e.operation} ${e.uri} (${e.scope})`).join(", ")}`,
			);
		});
	}
});
