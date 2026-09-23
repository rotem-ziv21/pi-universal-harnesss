import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { TaskContract } from "../contract/schema.ts";
import {
	createWorkspaceState,
	materializeResourceEffect,
	registeredResource,
	resourcePath,
	resourceUri,
} from "../resources/registry.ts";
import type {
	ResourceEffect,
	ResourceKind,
	ResourceOperation,
	TaskWorkspaceState,
} from "../resources/types.ts";
import type { HarnessState } from "../state/types.ts";
import type { ActionCapability, ActionSemantics, ActionType, ProposedAction } from "./types.ts";

export interface ActionSemanticContext {
	readonly cwd?: string;
	readonly contract?: TaskContract;
	readonly state?: HarnessState;
}

interface DraftEffect {
	reference: string;
	cwd: string;
	kind: ResourceKind;
	operation: ResourceOperation;
	reversible: boolean;
	external?: boolean;
	metadata?: Readonly<Record<string, unknown>>;
}

interface Operation {
	actionType: ActionType;
	classification: ActionSemantics["classification"];
	mutationType: ActionSemantics["mutationType"];
	reversibility: ActionSemantics["reversibility"];
	externalSideEffect: boolean;
	capabilities: ActionCapability[];
	operationText: string;
	effects: DraftEffect[];
}

interface ShellSegment {
	words: string[];
	connector?: ";" | "&&" | "||" | "|";
}

interface DeclaredSemantics {
	capabilities?: unknown;
	effects?: unknown;
	reversibility?: unknown;
	externalSideEffect?: unknown;
	operationText?: unknown;
}

const FILE_TOOL_NAMES: Record<string, "read" | "write" | "edit"> = {
	read: "read",
	read_file: "read",
	write: "write",
	create_file: "write",
	write_file: "write",
	edit: "edit",
	apply_patch: "edit",
	patch: "edit",
};

const SHELL_TOOL_NAMES: Record<string, true> = {
	bash: true,
	shell: true,
	sh: true,
	zsh: true,
	powershell: true,
	exec: true,
	command: true,
};

const MUTATING_CAPABILITIES: Partial<Record<ActionCapability, true>> = {
	create_resource: true,
	modify_resource: true,
	delete_resource: true,
	move_resource: true,
	install_dependency: true,
	commit: true,
	mutate_remote: true,
	publish: true,
	deploy: true,
	generate_artifact: true,
};

/** Normalize a tool call by adapter semantics, never by words inside payload data. */
export function withActionSemantics(action: ProposedAction, context: ActionSemanticContext = {}): ProposedAction {
	return { ...action, actionSemantics: classifyAction(action.toolName, action.input, context) };
}

export function classifyAction(
	toolName: string,
	input: Record<string, unknown>,
	context: ActionSemanticContext = {},
): ActionSemantics {
	const cwd = resolve(context.cwd ?? context.contract?.metadata.cwd ?? process.cwd());
	const workspace =
		context.state?.workspace ??
		createWorkspaceState(cwd, {
			allowedScopes: context.contract?.workspace?.allowedScopes,
			protectedResources: context.contract?.workspace?.protectedResources,
		});
	const leaf = toolName.toLowerCase().split(/[.:/]/).at(-1) ?? toolName.toLowerCase();
	const declared = declaredOperation(input, cwd, workspace);
	let operation: Operation;

	if (declared) {
		operation = declared;
	} else if (SHELL_TOOL_NAMES[leaf]) {
		const command = firstString(input, ["command", "cmd", "script"]);
		operation = command ? classifyShell(command, cwd, workspace) : unknownOperation(`${leaf} missing command`);
	} else if (FILE_TOOL_NAMES[leaf]) {
		operation = classifyFileTool(FILE_TOOL_NAMES[leaf], input, cwd, workspace);
	} else {
		operation = unknownOperation(leaf.replace(/[-_]/g, " "));
	}

	/**
	 * `/dev/null`, `/dev/stdout`, `/dev/tty` are device nodes, not resources. The
	 * redirection parser already skipped them; `curl -o /dev/null`, `tee /dev/null`
	 * and `cp x /dev/stdout` did not, and each was "a mutation outside the
	 * workspace". One rule, at the one place every effect passes through.
	 */
	const effects = operation.effects
		.filter((effect) => !isDeviceReference(effect.reference))
		.map((effect) => materializeResourceEffect({ ...effect, workspace }));
	const primary = [...effects].sort((a, b) => effectRisk(b) - effectRisk(a))[0];
	return {
		actionType: operation.actionType,
		classification: operation.classification,
		mutationType: operation.mutationType,
		reversibility:
			primary?.operation === "delete" && primary.provenance === "created_by_current_task"
				? "high"
				: operation.reversibility,
		externalSideEffect: operation.externalSideEffect || effects.some((effect) => effect.external),
		capabilities: unique(operation.capabilities),
		effects,
		...(primary ? { target: primary.uri } : {}),
		targetProvenance: primary?.provenance ?? "unknown",
		targetScope: primary?.scope ?? "unknown",
		operationText: operation.operationText,
	};
}

/** Safe text for model prompts. It contains active operations but no payload data. */
export function semanticActionText(action: ProposedAction): string {
	const semantics = action.actionSemantics;
	const path = semantics.target ? resourcePath(semantics.target) : undefined;
	return [semantics.actionType, ...semantics.capabilities, semantics.operationText, path ? basename(path) : semantics.target ?? ""]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

export function isSemanticMutation(action: ProposedAction): boolean {
	return action.actionSemantics.capabilities.some((capability) => MUTATING_CAPABILITIES[capability]);
}

function classifyFileTool(
	kind: "read" | "write" | "edit",
	input: Record<string, unknown>,
	cwd: string,
	workspace: TaskWorkspaceState,
): Operation {
	const target = firstString(input, ["path", "file", "filePath", "target", "destination"]);
	if (!target) return unknownOperation(`${kind} missing resource`);
	if (kind === "read") {
		return resourceOperation("read", target, cwd, workspace, "file", "read_resource", true, `resource_read ${target}`);
	}
	const operation = kind === "edit" ? "modify" : writeOperation(target, cwd, workspace);
	return resourceOperation(
		operation,
		target,
		cwd,
		workspace,
		"file",
		operation === "create" ? "create_resource" : "modify_resource",
		true,
		`resource_${operation} ${target}`,
	);
}

function declaredOperation(input: Record<string, unknown>, cwd: string, workspace: TaskWorkspaceState): Operation | undefined {
	const raw = input.harnessSemantics;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const declaration = raw as DeclaredSemantics;
	const capabilities = Array.isArray(declaration.capabilities)
		? declaration.capabilities.filter(isActionCapability)
		: [];
	const effects: DraftEffect[] = [];
	if (Array.isArray(declaration.effects)) {
		for (const item of declaration.effects) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const effect = item as Record<string, unknown>;
			if (typeof effect.uri !== "string" || !isResourceOperation(effect.operation) || !isResourceKind(effect.kind)) continue;
			effects.push({
				reference: effect.uri,
				cwd,
				kind: effect.kind,
				operation: effect.operation,
				reversible: effect.reversible !== false,
				external: effect.external === true,
			});
		}
	}
	const mutationType = mutationFromEffects(effects);
	return {
		actionType: effects.some((effect) => effect.external) ? "external_mutation" : effects.length > 0 ? "resource_mutation" : "local_execution",
		classification: "declared",
		mutationType,
		reversibility: isReversibility(declaration.reversibility) ? declaration.reversibility : "medium",
		externalSideEffect: declaration.externalSideEffect === true || effects.some((effect) => effect.external),
		capabilities,
		operationText: typeof declaration.operationText === "string" ? declaration.operationText : "declared tool operation",
		effects,
	};
}

function classifyShell(command: string, initialCwd: string, workspace: TaskWorkspaceState): Operation {
	const segments = shellSegments(command);
	const operations: Operation[] = [];
	let cwd = initialCwd;
	for (const segment of segments) {
		const commandWords = commandWordsWithoutRedirections(segment.words);
		const program = executableName(commandWords);
		if (program === "cd") {
			const destination = commandWords[1];
			if (destination && destination !== "-" && (segment.connector === "&&" || segment.connector === ";")) {
				cwd = resolve(cwd, destination);
			}
			continue;
		}
		operations.push(classifyCommandSegment(segment.words, cwd, workspace));
	}
	if (operations.length === 0) return localExecution("shell command");
	const primary = [...operations].sort((a, b) => operationRisk(b) - operationRisk(a))[0]!;
	return {
		...primary,
		classification: operations.some((operation) => operation.classification === "unknown") ? "unknown" : "known",
		externalSideEffect: operations.some((operation) => operation.externalSideEffect),
		capabilities: unique(operations.flatMap((operation) => operation.capabilities)),
		effects: operations.flatMap((operation) => operation.effects),
		operationText: operations.map((operation) => operation.operationText).join("; "),
	};
}

function classifyCommandSegment(words: string[], cwd: string, workspace: TaskWorkspaceState): Operation {
	const redirections = redirectionOperations(words, cwd, workspace);
	const clean = commandWordsWithoutRedirections(words);
	if (clean.length === 0) return combineOperation(localExecution("shell redirection"), redirections);
	let cursor = 0;
	while (["sudo", "command", "env"].includes(clean[cursor] ?? "")) cursor++;
	const program = basename(clean[cursor] ?? "").toLowerCase();
	const args = clean.slice(cursor + 1);
	let operation: Operation;

	if (["bash", "sh", "zsh"].includes(program) && args[0] === "-c" && args[1]) {
		operation = classifyShell(args[1], cwd, workspace);
	} else if (["rm", "rmdir", "unlink", "shred", "srm"].includes(program) || (program === "find" && args.includes("-delete"))) {
		const targets = program === "find" ? [args.find((arg) => !arg.startsWith("-"))].filter(isString) : pathArguments(args);
		operation = multiResourceOperation("delete", targets, cwd, workspace, "file", "delete_resource", false, `${program} delete`);
	} else if (program === "mkdir") {
		operation = multiResourceOperation("create", pathArguments(args), cwd, workspace, "directory", "create_resource", true, "directory create");
	} else if (program === "touch") {
		const targets = pathArguments(args);
		operation = multiWriteOperation(targets, cwd, workspace, "file", "touch");
	} else if (program === "tee") {
		const targets = pathArguments(args);
		operation = multiWriteOperation(targets, cwd, workspace, "file", "tee output");
	} else if (program === "mv" || program === "cp") {
		const targets = pathArguments(args);
		const destination = targets.at(-1);
		operation = destination
			? resourceOperation(
				writeOperation(destination, cwd, workspace),
				destination,
				cwd,
				workspace,
				"file",
				program === "mv" ? "move_resource" : "create_resource",
				program === "cp",
				program === "mv" ? "resource move" : "resource copy",
			)
			: unknownOperation(`${program} missing destination`);
	} else if (program === "git" && args[0] === "prune") {
		operation = resourceOperation(
			"delete",
			"vcs:unreachable-objects",
			cwd,
			workspace,
			"vcs_ref",
			"delete_resource",
			false,
			"version-control prune",
		);
	} else if (program === "docker" && args[0] === "system" && args[1] === "prune") {
		operation = resourceOperation(
			"delete",
			"runtime:unused-container-resources",
			cwd,
			workspace,
			"remote_resource",
			"delete_resource",
			false,
			"container-runtime prune",
		);
	} else if (program === "git" && args[0] === "push") {
		operation = externalOperation("publish", "git push", ["mutate_remote", "publish"]);
	} else if (program === "git" && args[0] === "commit") {
		operation = localExecution("version-control commit", ["commit"], "medium");
	} else if (isDependencyCommand(program, args)) {
		operation = localExecution("dependency installation", ["install_dependency"], "medium");
	} else if (isDeployCommand(program, args)) {
		operation = externalOperation("deploy", `${program} deployment`, ["deploy", "mutate_remote"]);
	} else if (program === "curl" || program === "wget") {
		const endpoint = args.find((arg) => /^https?:\/\//i.test(arg));
		const mutating =
			args.some((arg, index) => /^(?:-x|--request)$/i.test(arg) && /^(?:post|put|patch|delete)$/i.test(args[index + 1] ?? "")) ||
			args.some((arg) => /^(?:--data|-d|--upload-file|-t)$/i.test(arg));
		/**
		 * A request to the loopback interface talks to a process on this machine —
		 * usually the server the task itself just started. Its state lives in the
		 * workspace, so a POST there is the task exercising its own code, not a
		 * change to the outside world. Gating it as an external mutation sent a
		 * "curl the shortener you just wrote" smoke test to human review.
		 */
		const loopback = endpoint !== undefined && isLoopbackUrl(endpoint);
		operation = mutating
			? loopback
				? localExecution(`${program} local request`, ["query_resource"])
				: externalOperation("modify", `${program} remote mutation`, ["mutate_remote"], endpoint)
			: endpoint
				? resourceOperation("read", endpoint, cwd, workspace, "remote_resource", "query_resource", true, `${program} remote query`)
				: localExecution(`${program} request`, ["query_resource"]);
		// `-o file` / `--output file` / `-O` write the response to disk: a local file effect
		// that scope policy must see, exactly like a shell redirection.
		const outputs: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if ((arg === "-o" || arg === "--output" || arg === "--output-document") && args[index + 1]) outputs.push(args[index + 1]!);
			else if (/^--output=(.+)$/.test(arg)) outputs.push(arg.replace(/^--output=/, ""));
			else if (arg === "-O" || arg === "--remote-name") outputs.push(basename(endpoint?.split("?")[0] ?? "download"));
		}
		if (outputs.length > 0) {
			operation = combineOperation(operation, [multiWriteOperation(outputs, cwd, workspace, "file", `${program} output`)]);
		}
	} else if (["cat", "head", "tail", "less", "more", "stat", "wc", "grep", "rg", "find"].includes(program)) {
		const target = pathArguments(args).at(-1);
		operation = target
			? resourceOperation("read", target, cwd, workspace, "file", "read_resource", true, `${program} resource read`)
			: localExecution(`${program} query`, ["query_resource"]);
	} else {
		operation = localExecution(`execute ${program || "command"}`);
	}
	return combineOperation(operation, redirections);
}

function redirectionOperations(words: string[], cwd: string, workspace: TaskWorkspaceState): Operation[] {
	const operations: Operation[] = [];
	for (let index = 0; index < words.length; index++) {
		const token = words[index]!;
		const match = /^(\d*)(>>?|<)(?:&(\d+|-))?$/.exec(token);
		if (!match) continue;
		if (match[3] !== undefined) continue;
		const target = words[index + 1];
		if (!target || isControlToken(target) || isRedirectionToken(target)) continue;
		/**
		 * `2>/dev/null`, `>/dev/stderr`, `</dev/tty`: device nodes, not resources. Treating
		 * them as files "outside the workspace" blocked the most ordinary shell idiom
		 * there is, twice in one run, and taught the worker nothing useful.
		 */
		if (/^\/dev\//.test(target)) continue;
		const input = match[2] === "<";
		if (input) {
			operations.push(resourceOperation("read", target, cwd, workspace, "file", "read_resource", true, "input redirection"));
		} else {
			const write = writeOperation(target, cwd, workspace);
			operations.push(
				resourceOperation(
					write,
					target,
					cwd,
					workspace,
					"file",
					write === "create" ? "create_resource" : "modify_resource",
					true,
					"output redirection",
				),
			);
		}
	}
	return operations;
}

function commandWordsWithoutRedirections(words: string[]): string[] {
	const clean: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const token = words[index]!;
		if (!isRedirectionToken(token)) {
			clean.push(token);
			continue;
		}
		if (!/^(\d*)(>>?|<)&(\d+|-)$/.test(token)) index++;
	}
	return clean;
}

function resourceOperation(
	operation: ResourceOperation,
	reference: string,
	cwd: string,
	_workspace: TaskWorkspaceState,
	kind: ResourceKind,
	capability: ActionCapability,
	reversible: boolean,
	operationText: string,
	external = false,
): Operation {
	return {
		actionType: external ? "external_mutation" : operation === "read" || operation === "query" ? "resource_read" : "resource_mutation",
		classification: "known",
		mutationType: mutationTypeFor(operation),
		reversibility: reversible ? "high" : "low",
		externalSideEffect: external,
		capabilities: [capability],
		operationText,
		effects: [{ reference, cwd, kind, operation, reversible, external }],
	};
}

function multiResourceOperation(
	operation: ResourceOperation,
	targets: string[],
	cwd: string,
	workspace: TaskWorkspaceState,
	kind: ResourceKind,
	capability: ActionCapability,
	reversible: boolean,
	operationText: string,
): Operation {
	if (targets.length === 0) return unknownOperation(`${operationText} missing target`);
	const first = resourceOperation(operation, targets[0]!, cwd, workspace, kind, capability, reversible, operationText);
	return {
		...first,
		effects: targets.map((reference) => ({ reference, cwd, kind, operation, reversible })),
		operationText: `${operationText} ${targets.join(" ")}`,
	};
}

function multiWriteOperation(
	targets: string[],
	cwd: string,
	workspace: TaskWorkspaceState,
	kind: ResourceKind,
	operationText: string,
): Operation {
	if (targets.length === 0) return unknownOperation(`${operationText} missing target`);
	const effects = targets.map((reference) => {
		const operation = writeOperation(reference, cwd, workspace);
		return { reference, cwd, kind, operation, reversible: true } satisfies DraftEffect;
	});
	return {
		actionType: "resource_mutation",
		classification: "known",
		mutationType: effects.some((effect) => effect.operation === "modify") ? "modify" : "create",
		reversibility: "high",
		externalSideEffect: false,
		capabilities: unique(
			effects.map((effect) => (effect.operation === "create" ? "create_resource" : "modify_resource")),
		),
		operationText,
		effects,
	};
}

function externalOperation(
	operation: "modify" | "publish" | "deploy",
	operationText: string,
	capabilities: ActionCapability[],
	target = `external:${operationText.replace(/\s+/g, "-")}`,
): Operation {
	return {
		actionType: "external_mutation",
		classification: "known",
		mutationType: "modify",
		reversibility: "low",
		externalSideEffect: true,
		capabilities,
		operationText,
		effects: [{ reference: target, cwd: process.cwd(), kind: operation === "deploy" ? "deployment" : "remote_resource", operation, reversible: false, external: true }],
	};
}

function localExecution(
	operationText: string,
	capabilities: ActionCapability[] = ["execute_code"],
	reversibility: ActionSemantics["reversibility"] = "high",
): Operation {
	return {
		actionType: "local_execution",
		classification: "known",
		mutationType: "execute",
		reversibility,
		externalSideEffect: false,
		capabilities,
		operationText,
		effects: [],
	};
}

function unknownOperation(operationText: string): Operation {
	return {
		actionType: "unknown",
		classification: "unknown",
		mutationType: "none",
		reversibility: "medium",
		externalSideEffect: false,
		capabilities: [],
		operationText,
		effects: [],
	};
}

function combineOperation(primary: Operation, additions: Operation[]): Operation {
	if (additions.length === 0) return primary;
	const operations = [primary, ...additions];
	const riskiest = [...operations].sort((a, b) => operationRisk(b) - operationRisk(a))[0]!;
	return {
		...riskiest,
		classification: operations.some((operation) => operation.classification === "unknown") ? "unknown" : "known",
		externalSideEffect: operations.some((operation) => operation.externalSideEffect),
		capabilities: unique(operations.flatMap((operation) => operation.capabilities)),
		effects: operations.flatMap((operation) => operation.effects),
		operationText: operations.map((operation) => operation.operationText).join("; "),
	};
}

function writeOperation(reference: string, cwd: string, workspace: TaskWorkspaceState): "create" | "modify" {
	const uri = resourceUri(reference, cwd);
	const registered = registeredResource(uri, workspace);
	if (registered?.status === "active") return "modify";
	const path = resourcePath(uri);
	return path && existsSync(path) ? "modify" : "create";
}

function effectRisk(effect: ResourceEffect): number {
	if (effect.external) return 100;
	if (effect.scope === "protected") return 95;
	if (effect.scope === "outside_allowed") return 90;
	if (effect.operation === "delete" && effect.provenance === "preexisting") return 85;
	if (effect.operation === "delete") return 60;
	if (["create", "modify", "move"].includes(effect.operation)) return 40;
	return 10;
}

function operationRisk(operation: Operation): number {
	if (operation.externalSideEffect) return 100;
	if (operation.capabilities.includes("delete_resource")) return 90;
	if (operation.reversibility === "low") return 80;
	if (operation.mutationType === "modify" || operation.mutationType === "create") return 60;
	if (operation.mutationType === "execute") return 30;
	return 10;
}

function mutationTypeFor(operation: ResourceOperation): ActionSemantics["mutationType"] {
	if (operation === "create") return "create";
	if (operation === "delete") return "delete";
	if (operation === "read" || operation === "query") return "read";
	if (operation === "execute") return "execute";
	return "modify";
}

function mutationFromEffects(effects: DraftEffect[]): ActionSemantics["mutationType"] {
	if (effects.some((effect) => effect.operation === "delete")) return "delete";
	if (effects.some((effect) => effect.operation === "modify" || effect.operation === "move" || effect.operation === "publish" || effect.operation === "deploy")) return "modify";
	if (effects.some((effect) => effect.operation === "create")) return "create";
	if (effects.some((effect) => effect.operation === "read" || effect.operation === "query")) return "read";
	return "none";
}

function pathArguments(args: string[]): string[] {
	return args.filter((arg) => arg.length > 0 && !arg.startsWith("-") && !isControlToken(arg) && !isRedirectionToken(arg));
}

function executableName(words: string[]): string {
	let cursor = 0;
	while (["sudo", "command", "env"].includes(words[cursor] ?? "")) cursor++;
	return basename(words[cursor] ?? "").toLowerCase();
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isDeviceReference(reference: string): boolean {
	return /^\/dev\//.test(reference) || /^file:\/\/\/dev\//.test(reference);
}

function isLoopbackUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
		return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".localhost");
	} catch {
		return false;
	}
}

function isDependencyCommand(program: string, args: string[]): boolean {
	return (
		(["npm", "pnpm"].includes(program) && ["install", "i", "add", "update", "uninstall", "remove"].includes(args[0] ?? "")) ||
		(program === "yarn" && ["add", "install", "remove", "upgrade"].includes(args[0] ?? "")) ||
		(["pip", "pip3"].includes(program) && ["install", "uninstall"].includes(args[0] ?? "")) ||
		(program === "python" && args[0] === "-m" && /^pip\d*$/.test(args[1] ?? "") && ["install", "uninstall"].includes(args[2] ?? "")) ||
		(program === "uv" && ["add", "remove", "sync", "pip"].includes(args[0] ?? ""))
	);
}

function isDeployCommand(program: string, args: string[]): boolean {
	return (
		["deploy", "vercel", "netlify", "flyctl", "kubectl", "helm", "terraform"].includes(program) ||
		(program === "npm" && args[0] === "publish")
	);
}

function shellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const flushWord = () => {
		if (current) words.push(current);
		current = "";
	};
	const flushSegment = (connector?: ShellSegment["connector"]) => {
		flushWord();
		if (words.length > 0) segments.push({ words, ...(connector ? { connector } : {}) });
		words = [];
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		/**
		 * A newline ends a command exactly like `;`. Without this, a multi-line
		 * script collapsed into one segment: `grep`'s "last argument" became the
		 * JSON body of the curl on the next line, and a `tee` target picked up
		 * `{oops`, a deliberately broken request body. The harness then blocked a
		 * "file creation" that no shell would ever perform.
		 */
		if (char === "\n") {
			flushSegment(";");
			continue;
		}
		if (/\s/.test(char)) {
			flushWord();
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (pair === "&&" || pair === "||") {
			flushSegment(pair);
			index++;
			continue;
		}
		if (char === ";" || char === "|") {
			flushSegment(char);
			continue;
		}
		// A lone `&` backgrounds the command so far and starts a new one, like `;`.
		if (char === "&") {
			flushSegment(";");
			continue;
		}
		if (char === ">" || char === "<") {
			let prefix = "";
			if (/^\d+$/.test(current)) {
				prefix = current;
				current = "";
			} else {
				flushWord();
			}
			let operator = `${prefix}${char}`;
			if (char === ">" && command[index + 1] === ">") {
				operator += ">";
				index++;
			}
			if (command[index + 1] === "&") {
				operator += "&";
				index++;
				while (/\d|-/.test(command[index + 1] ?? "")) {
					operator += command[++index];
				}
			}
			words.push(operator);
			continue;
		}
		current += char;
	}
	flushSegment();
	return segments;
}

function isRedirectionToken(token: string): boolean {
	return /^(\d*)(>>?|<)(?:&(\d+|-))?$/.test(token);
}

function isControlToken(token: string): boolean {
	return token === ";" || token === "&&" || token === "||" || token === "|";
}

function isString(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function isReversibility(value: unknown): value is ActionSemantics["reversibility"] {
	return value === "high" || value === "medium" || value === "low";
}

function isActionCapability(value: unknown): value is ActionCapability {
	return (
		typeof value === "string" &&
		[
			"read_resource",
			"create_resource",
			"modify_resource",
			"delete_resource",
			"move_resource",
			"query_resource",
			"execute_code",
			"install_dependency",
			"commit",
			"mutate_remote",
			"publish",
			"deploy",
			"generate_artifact",
		].includes(value)
	);
}

function isResourceOperation(value: unknown): value is ResourceOperation {
	return typeof value === "string" && ["read", "create", "modify", "delete", "move", "execute", "query", "publish", "deploy"].includes(value);
}

function isResourceKind(value: unknown): value is ResourceKind {
	return (
		typeof value === "string" &&
		["file", "directory", "vcs_ref", "api_object", "database_record", "deployment", "artifact", "remote_resource", "unknown"].includes(value)
	);
}
