import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { activate, type PiExtensionAPI } from "../src/pi/extension.ts";
import { fakeJev, type Responder } from "./helpers.ts";

/**
 * The Pi wiring, end to end, against a fake Pi. This is the layer where the old
 * harness looped, and it had no tests at all.
 */

interface Sent {
	content: string;
	triggerTurn: boolean | undefined;
}

function fakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const sent: Sent[] = [];
	const pi: PiExtensionAPI = {
		on: (event, handler) => void handlers.set(event, handler),
		registerCommand: () => {},
		sendMessage: (message, options) => void sent.push({ content: message.content, triggerTurn: options?.triggerTurn }),
	};
	const fire = (event: string, payload: any, ctx: any) => handlers.get(event)?.(payload, ctx);
	return { pi, sent, fire };
}

function makeCtx(cwd: string, confirmAnswer: boolean) {
	const notes: string[] = [];
	const confirms: string[] = [];
	return {
		notes,
		confirms,
		ctx: {
			cwd,
			hasUI: true,
			isProjectTrusted: () => false,
			modelRegistry: { getApiKeyForProvider: async () => "sk-or-test" },
			ui: {
				notify: (text: string) => void notes.push(text),
				setStatus: () => {},
				setWidget: () => {},
				confirm: async (title: string) => {
					confirms.push(title);
					return confirmAnswer;
				},
			},
		},
	};
}

const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

let restoreFetch: typeof fetch;
let configDir: string;

function setup(respond: Responder, confirmAnswer = false) {
	const jev = fakeJev(respond);
	globalThis.fetch = jev.fetchImpl;
	const { pi, sent, fire } = fakePi();
	activate(pi);
	const workspace = mkdtempSync(join(tmpdir(), "harness-ws-"));
	const c = makeCtx(workspace, confirmAnswer);
	return { jev, sent, fire, ...c };
}

beforeEach(() => {
	restoreFetch = globalThis.fetch;
	configDir = mkdtempSync(join(tmpdir(), "harness-cfg-"));
	process.env.PI_HARNESS_CONFIG_DIR = configDir;
	delete process.env.PI_HARNESS_HOME;
});

afterEach(() => {
	globalThis.fetch = restoreFetch;
	delete process.env.PI_HARNESS_CONFIG_DIR;
});

describe("extension", () => {
	const claimsDone = { claims_done: 0.95, verification_applies: 0.9, outcome: "complete" };

	it("an unverified 'done' gets exactly one nudge, then the run ends and the user is told", async () => {
		const { fire, ctx, sent, notes } = setup(() => claimsDone);
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "Fix the parser bug" }, ctx);

		assert.equal(await fire("tool_call", { toolName: "edit", toolCallId: "1", input: { path: "src/parse.ts", edits: [] } }, ctx), undefined);
		await fire("tool_result", { toolName: "edit", toolCallId: "1", input: { path: "src/parse.ts" }, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
		await fire("agent_end", { messages: [assistant("Fixed it, everything works.")] }, ctx);
		await fire("agent_settled", {}, ctx);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.triggerTurn, true);
		assert.match(sent[0]!.content, /no test, build or check has passed/);

		// The nudged turn: the worker just repeats itself.
		await fire("agent_end", { messages: [assistant("It is fixed.")] }, ctx);
		await fire("agent_settled", {}, ctx);
		assert.equal(sent.length, 1, "no second nudge");
		assert.ok(notes.some((n) => /not verified/.test(n)));
	});

	it("running the tests after the change ends the run as verified, with no Judge call", async () => {
		const { fire, ctx, sent, jev, notes } = setup(() => claimsDone);
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "Fix the parser bug" }, ctx);
		await fire("tool_call", { toolName: "edit", toolCallId: "1", input: { path: "src/parse.ts" } }, ctx);
		await fire("tool_result", { toolName: "edit", toolCallId: "1", input: { path: "src/parse.ts" }, content: [], isError: false }, ctx);
		await fire("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "npm test" } }, ctx);
		await fire("tool_result", { toolName: "bash", toolCallId: "2", input: { command: "npm test" }, content: [{ type: "text", text: "# pass 12\n# fail 0" }], isError: false }, ctx);
		await fire("agent_end", { messages: [assistant("Fixed; tests pass.")] }, ctx);
		await fire("agent_settled", {}, ctx);
		assert.equal(sent.length, 0);
		assert.equal(jev.calls.length, 0);
		assert.ok(notes.some((n) => /a check passed after the last change/.test(n)));
	});

	it("a provider error is not treated as a completion", async () => {
		const { fire, ctx, sent, jev } = setup(() => claimsDone);
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "Fix it" }, ctx);
		await fire("tool_result", { toolName: "edit", toolCallId: "1", input: { path: "a.ts" }, content: [], isError: false }, ctx);
		await fire("agent_end", { messages: [assistant("", "error")] }, ctx);
		await fire("agent_settled", {}, ctx);
		assert.equal(sent.length, 0);
		assert.equal(jev.calls.length, 0);
	});

	it("the deny list blocks, and the reason is what the model reads", async () => {
		const { fire, ctx } = setup(() => ({}));
		await fire("session_start", {}, ctx);
		const result = (await fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "rm -rf ~" } }, ctx)) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.match(result.reason, /Do not retry it/);
	});

	it("with a UI, a held action is the user's call, and an approval sticks", async () => {
		const declined = setup(() => ({ destructive: 0.95 }), false);
		await declined.fire("session_start", {}, declined.ctx);
		const blocked = (await declined.fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "rm -rf data" } }, declined.ctx)) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /declined/);

		const approved = setup(() => ({ destructive: 0.95 }), true);
		await approved.fire("session_start", {}, approved.ctx);
		assert.equal(await approved.fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "rm -rf data" } }, approved.ctx), undefined);
		assert.equal(await approved.fire("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "rm -rf data" } }, approved.ctx), undefined);
		assert.equal(approved.confirms.length, 1, "asked once");
	});

	it("a call that keeps failing the same way gets a note in its result", async () => {
		const { fire, ctx } = setup(() => ({}));
		await fire("session_start", {}, ctx);
		const failing = { toolName: "bash", toolCallId: "x", input: { command: "node server.js" }, content: [{ type: "text", text: "Error: Cannot find module 'express'" }], isError: true };
		await fire("tool_result", failing, ctx);
		await fire("tool_result", failing, ctx);
		const third = (await fire("tool_result", failing, ctx)) as { content: Array<{ text: string }> };
		assert.match(third.content.at(-1)!.text, /failed the same way 3 times/);
	});

	it("the harness makes no language-model calls: the worker model is irrelevant to it", async () => {
		const { fire, ctx, jev } = setup(() => ({}));
		const touched: string[] = [];
		const trap = new Proxy({}, { get: (_t, key) => (touched.push(String(key)), undefined) });
		const withModel = { ...ctx, model: trap };
		await fire("session_start", {}, withModel);
		await fire("before_agent_start", { prompt: "Refactor the store module and keep the API" }, withModel);
		await fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls" } }, withModel);
		assert.deepEqual(touched, []);
		assert.equal(jev.calls.length, 0);
	});
});
