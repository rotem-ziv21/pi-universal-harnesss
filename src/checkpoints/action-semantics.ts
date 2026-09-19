import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskContract } from "../contract/schema.ts";
import type { HarnessState } from "../state/types.ts";
import type { ActionCapability, ActionSemantics, ActionType, ProposedAction } from "./types.ts";

export interface ActionSemanticContext {
	readonly cwd?: string;
	readonly contract?: TaskContract;
	readonly state?: HarnessState;
}

interface Operation {
	actionType: ActionType;
	mutationType: ActionSemantics["mutationType"];
	reversibility: ActionSemantics["reversibility"];
	externalSideEffect: boolean;
	capabilities: ActionCapability[];
	operationText: string;
	target?: string;
}

const PAYLOAD_KEYS: Record<string, true> = {
	content: true,
	newText: true,
	oldText: true,
	edits: true,
	data: true,
	body: true,
	patch: true,
	replacement: true,
};

/**
 * Normalize a tool call by what the tool will do, not by words inside data it carries.
 * File contents, patches, request bodies and replacement text never enter classification.
 */
export function withActionSemantics(action: ProposedAction, context: ActionSemanticContext = {}): ProposedAction {
	return { ...action, actionSemantics: classifyAction(action.toolName, action.input, context) };
}

export function classifyAction(
	toolName: string,
	input: Record<string, unknown>,
	context: ActionSemanticContext = {},
): ActionSemantics {
	const leaf = toolName.toLowerCase().split(/[.:/]/).at(-1) ?? toolName.toLowerCase();
	const command = firstString(input, ["command", "cmd", "script"]);
	let operation: Operation;

	if (command && /^(bash|shell|sh|zsh|powershell|exec|command)$/.test(leaf)) {
		operation = classifyShell(command);
	} else if (/^(write|create_file|write_file)$/.test(leaf) || hasPayload(input, ["content", "newText", "replacement"])) {
		const target = firstString(input, ["path", "file", "filePath", "target", "destination"]);
		const absolute = resolveTarget(target, context.cwd);
		const exists = absolute ? existsSync(absolute) : false;
		operation = {
			actionType: "file_write",
			mutationType: exists ? "modify" : "create",
			reversibility: "high",
			externalSideEffect: false,
			capabilities: ["write_file"],
			operationText: `file_write${target ? ` ${target}` : ""}`,
			...(target ? { target } : {}),
		};
	} else if (/^(edit|apply_patch|patch)$/.test(leaf) || hasPayload(input, ["edits", "patch", "oldText"])) {
		const target = firstString(input, ["path", "file", "filePath", "target"]);
		operation = {
			actionType: "file_write",
			mutationType: "modify",
			reversibility: "high",
			externalSideEffect: false,
			capabilities: ["write_file"],
			operationText: `file_write modify${target ? ` ${target}` : ""}`,
			...(target ? { target } : {}),
		};
	} else if (/^(read|cat|read_file)$/.test(leaf)) {
		const target = firstString(input, ["path", "file", "filePath", "target"]);
		operation = readOperation(target);
	} else {
		operation = classifyStructuredTool(leaf, input);
	}

	const pathTarget = ["file_read", "file_write", "file_delete", "file_move", "directory_create", "local_command", "execute_local_code"].includes(
		operation.actionType,
	);
	const normalizedTarget = pathTarget ? resolveTarget(operation.target, context.cwd) : operation.target;
	const mutationType =
		operation.actionType === "file_write" && normalizedTarget
			? existsSync(normalizedTarget)
				? "modify"
				: "create"
			: operation.mutationType;
	const targetOwnership = operation.externalSideEffect ? "unknown" : ownershipOf(normalizedTarget, mutationType, context);
	return {
		...operation,
		mutationType,
		...(normalizedTarget ? { target: normalizedTarget } : {}),
		targetOwnership,
		reversibility:
			operation.actionType === "file_delete" && targetOwnership === "task_created" ? "high" : operation.reversibility,
	};
}

/** Safe text for contract matching. It contains active operations but no payload data. */
export function semanticActionText(action: ProposedAction): string {
	const semantics = action.actionSemantics;
	return [
		semantics.actionType,
		...semantics.capabilities,
		semantics.operationText,
		semantics.target ? basename(semantics.target) : "",
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

export function isSemanticMutation(action: ProposedAction): boolean {
	return action.actionSemantics.mutationType !== "read" && action.actionSemantics.mutationType !== "none";
}

function classifyStructuredTool(leaf: string, input: Record<string, unknown>): Operation {
	const target = firstString(input, ["path", "file", "filePath", "target", "destination"]);
	const safeArgs = Object.entries(input)
		.filter(([key, value]) => !(key in PAYLOAD_KEYS) && typeof value === "string")
		.map(([, value]) => String(value))
		.join(" ");
	const name = leaf.replace(/[-_]/g, " ");

	if (/\b(delete|remove|unlink|truncate)\b/.test(name)) {
		return destructiveOperation(target, `${name}${target ? ` ${target}` : ""}`);
	}
	if (/\b(push|publish|upload|send|submit|post)\b/.test(name)) {
		return remoteOperation(`${name} ${safeArgs}`.trim(), target);
	}
	if (/\b(deploy|release)\b/.test(name)) {
		return deploymentOperation(`${name} ${safeArgs}`.trim(), target);
	}
	if (/\b(install|dependency|package)\b/.test(name)) {
		return dependencyOperation(`${name} ${safeArgs}`.trim(), target);
	}
	if (/\b(read|get|list|search|find|glob|inspect)\b/.test(name)) return readOperation(target);

	return {
		actionType: "unknown",
		mutationType: "none",
		reversibility: "medium",
		externalSideEffect: false,
		capabilities: [],
		operationText: `${name}${target ? ` ${target}` : ""}`,
		...(target ? { target } : {}),
	};
}

function classifyShell(command: string): Operation {
	const segments = shellSegments(command);
	const operations = segments.map(classifyCommandSegment);
	if (operations.length === 0) return localCommand("shell command");
	operations.sort((a, b) => riskRank(b) - riskRank(a));
	const primary = operations[0]!;
	const capabilities = [...new Set(operations.flatMap((item) => item.capabilities))];
	return {
		...primary,
		capabilities,
		externalSideEffect: operations.some((item) => item.externalSideEffect),
		operationText: operations.map((item) => item.operationText).join("; "),
	};
}

function classifyCommandSegment(words: string[]): Operation {
	if (words.length === 0) return localCommand("shell command");
	let cursor = 0;
	while (words[cursor] === "sudo" || words[cursor] === "command" || words[cursor] === "env") cursor++;
	const program = basename(words[cursor] ?? "").toLowerCase();
	const args = words.slice(cursor + 1);

	if ((program === "bash" || program === "sh" || program === "zsh") && args[0] === "-c" && args[1]) {
		return classifyShell(args[1]);
	}
	if (["rm", "rmdir", "unlink", "shred", "srm"].includes(program) || (program === "find" && args.includes("-delete"))) {
		const target = lastTarget(args);
		return destructiveOperation(target, `${program} delete${target ? ` ${target}` : ""}`);
	}
	if ((program === "git" && args[0] === "prune") || (program === "docker" && args[0] === "system" && args[1] === "prune")) {
		return destructiveOperation(undefined, `${program} destructive prune`);
	}
	if (program === "git" && args[0] === "push") return remoteOperation("git push", args.at(-1));
	if (program === "git" && args[0] === "commit") {
		return {
			actionType: "git_commit",
			mutationType: "modify",
			reversibility: "medium",
			externalSideEffect: false,
			capabilities: ["commit_git"],
			operationText: "git commit",
		};
	}
	if (isDependencyCommand(program, args)) return dependencyOperation(`${program} ${args[0] ?? "install"}`, dependencyTarget(args));
	if (isDeployCommand(program, args)) return deploymentOperation(`${program} ${args.slice(0, 2).join(" ")}`.trim());
	if (isDatabaseMutation(program, args)) {
		return {
			actionType: "database_mutation",
			mutationType: "modify",
			reversibility: "low",
			externalSideEffect: true,
			capabilities: ["mutate_database"],
			operationText: `${program} database mutation`,
		};
	}
	if (program === "curl" || program === "wget") {
		const mutating = args.some((arg, index) => /^(-x|--request)$/i.test(arg) && /^(post|put|patch|delete)$/i.test(args[index + 1] ?? "")) ||
			args.some((arg) => /^(--data|-d|--upload-file|-t)$/i.test(arg));
		return mutating ? remoteOperation(`${program} remote mutation`, args.find((arg) => /^https?:\/\//i.test(arg))) : readOperation(args.find((arg) => /^https?:\/\//i.test(arg)));
	}
	if (["touch", "tee"].includes(program) || words.includes(">") || words.includes(">>")) {
		const redirection = words.findIndex((word) => word === ">" || word === ">>");
		const target = redirection >= 0 ? words[redirection + 1] : lastTarget(args);
		return {
			actionType: "file_write",
			mutationType: "modify",
			reversibility: "high",
			externalSideEffect: false,
			capabilities: ["write_file"],
			operationText: `file_write${target ? ` ${target}` : ""}`,
			...(target ? { target } : {}),
		};
	}
	if (["cat", "head", "tail", "less", "more", "stat", "wc", "grep", "rg", "ls", "find"].includes(program)) {
		return readOperation(lastTarget(args));
	}
	if (program === "mkdir") {
		const target = lastTarget(args);
		return {
			actionType: "directory_create",
			mutationType: "create",
			reversibility: "high",
			externalSideEffect: false,
			capabilities: ["create_directory"],
			operationText: `directory_create${target ? ` ${target}` : ""}`,
			...(target ? { target } : {}),
		};
	}
	if (["mv", "cp"].includes(program)) {
		const target = lastTarget(args);
		return {
			actionType: "file_move",
			mutationType: "modify",
			reversibility: "medium",
			externalSideEffect: false,
			capabilities: [program === "mv" ? "move_file" : "write_file"],
			operationText: `${program === "mv" ? "file_move" : "file_write"}${target ? ` ${target}` : ""}`,
			...(target ? { target } : {}),
		};
	}

	const tests = isTestCommand(program, args);
	return {
		actionType: "execute_local_code",
		mutationType: "execute",
		reversibility: "high",
		externalSideEffect: false,
		capabilities: tests ? ["execute_local_code", "run_tests"] : ["execute_local_code"],
		operationText: `${tests ? "run_tests" : "execute_local_code"} ${program}${lastTarget(args) ? ` ${lastTarget(args)}` : ""}`,
		...(lastTarget(args) ? { target: lastTarget(args) } : {}),
	};
}

function ownershipOf(
	target: string | undefined,
	mutationType: ActionSemantics["mutationType"],
	context: ActionSemanticContext,
): ActionSemantics["targetOwnership"] {
	if (!target) return "unknown";
	const cwd = context.cwd ? resolve(context.cwd) : undefined;
	if (cwd && isOutside(target, cwd)) return "outside_scope";

	const roots = taskOwnedRoots(context.state, cwd);
	if (roots.some((root) => !isOutside(target, root))) return "task_created";
	if (requiresSingleTaskFolder(context.contract) && roots.length > 0) return "outside_scope";
	if (existsSync(target)) return "preexisting";
	if (mutationType === "create" || mutationType === "modify") return "task_created";
	return "unknown";
}

function taskOwnedRoots(state: HarnessState | undefined, cwd: string | undefined): string[] {
	if (!state) return [];
	const roots = new Set<string>();
	for (const action of state.actions) {
		const semantics = action.actionSemantics;
		if (action.outcome !== "succeeded" || !semantics?.target || semantics.targetOwnership !== "task_created") continue;
		const target = semantics.actionType === "directory_create" ? semantics.target : dirname(semantics.target);
		if (!cwd || isOutside(target, cwd)) continue;
		const rel = relative(cwd, target);
		const first = rel.split(sep)[0];
		if (first && first !== ".") roots.add(resolve(cwd, first));
	}
	return [...roots];
}

function requiresSingleTaskFolder(contract: TaskContract | undefined): boolean {
	if (!contract) return false;
	const text = [contract.originalRequest, ...contract.constraints.map((constraint) => constraint.description)].join(" ");
	return /(?:outside|only (?:in|inside|within)).{0,50}(?:new |task[- ]owned )?(?:task )?(?:folder|directory)/i.test(text);
}

function resolveTarget(target: string | undefined, cwd: string | undefined): string | undefined {
	if (!target || /^https?:\/\//i.test(target)) return target;
	if (!cwd) return isAbsolute(target) ? resolve(target) : target;
	return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

function isOutside(target: string, root: string): boolean {
	if (/^https?:\/\//i.test(target)) return false;
	const rel = relative(root, target);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function readOperation(target?: string): Operation {
	return {
		actionType: "file_read",
		mutationType: "read",
		reversibility: "high",
		externalSideEffect: false,
		capabilities: ["read_file"],
		operationText: `file_read${target ? ` ${target}` : ""}`,
		...(target ? { target } : {}),
	};
}

function destructiveOperation(target: string | undefined, operationText: string): Operation {
	return {
		actionType: "file_delete",
		mutationType: "delete",
		reversibility: "low",
		externalSideEffect: false,
		capabilities: ["delete_file"],
		operationText,
		...(target ? { target } : {}),
	};
}

function remoteOperation(operationText: string, target?: string): Operation {
	return {
		actionType: "remote_mutation",
		mutationType: "modify",
		reversibility: "low",
		externalSideEffect: true,
		capabilities: ["mutate_remote"],
		operationText,
		...(target ? { target } : {}),
	};
}

function deploymentOperation(operationText: string, target?: string): Operation {
	return {
		actionType: "deployment",
		mutationType: "modify",
		reversibility: "low",
		externalSideEffect: true,
		capabilities: ["deploy", "mutate_remote"],
		operationText,
		...(target ? { target } : {}),
	};
}

function dependencyOperation(operationText: string, target?: string): Operation {
	return {
		actionType: "dependency_change",
		mutationType: "modify",
		reversibility: "medium",
		externalSideEffect: false,
		capabilities: ["change_dependencies"],
		operationText,
		...(target ? { target } : {}),
	};
}

function localCommand(operationText: string): Operation {
	return {
		actionType: "local_command",
		mutationType: "execute",
		reversibility: "high",
		externalSideEffect: false,
		capabilities: ["execute_local_code"],
		operationText,
	};
}

function riskRank(operation: Operation): number {
	if (operation.externalSideEffect) return 100;
	if (operation.actionType === "file_delete") return 90;
	if (operation.actionType === "git_commit") return 80;
	if (operation.actionType === "dependency_change") return 70;
	if (operation.mutationType === "modify" || operation.mutationType === "create") return 60;
	if (operation.mutationType === "execute") return 30;
	return 10;
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

function dependencyTarget(args: string[]): string | undefined {
	return args.find((arg, index) => index > 0 && !arg.startsWith("-"));
}

function isDeployCommand(program: string, args: string[]): boolean {
	return ["deploy", "vercel", "netlify", "flyctl", "kubectl", "helm", "terraform"].includes(program) ||
		(program === "npm" && ["publish"].includes(args[0] ?? "")) ||
		(program === "git" && ["tag"].includes(args[0] ?? ""));
}

function isDatabaseMutation(program: string, args: string[]): boolean {
	if (!["psql", "mysql", "sqlite3", "mongosh", "redis-cli"].includes(program)) return false;
	return args.some((arg) => /\b(insert|update|delete|drop|alter|truncate|create|set|del|flush)\b/i.test(arg));
}

function isTestCommand(program: string, args: string[]): boolean {
	if (/^(pytest|jest|vitest|mocha|ava)$/.test(program)) return true;
	if (["npm", "pnpm", "yarn", "bun"].includes(program) && args.some((arg) => /^(test|check)$/.test(arg))) return true;
	if (/^(python|python3)$/.test(program) && (args.includes("-m") && args.some((arg) => /^(unittest|pytest)$/.test(arg)))) return true;
	return args.some((arg) => /(^|[/_.-])(tests?|spec)([/_.-]|$)/i.test(arg));
}

function lastTarget(args: string[]): string | undefined {
	return [...args].reverse().find((arg) => arg && !arg.startsWith("-") && !/^(2?>|&&|\|\||\|)$/.test(arg));
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function hasPayload(input: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.some((key) => key in input && input[key] !== undefined);
}

/** Small shell lexer: enough to identify active programs without interpreting payload strings. */
function shellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const flushWord = () => {
		if (current) words.push(current);
		current = "";
	};
	const flushSegment = () => {
		flushWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
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
		if (/\s/.test(char)) {
			flushWord();
			continue;
		}
		const pair = command.slice(i, i + 2);
		if (pair === "&&" || pair === "||") {
			flushSegment();
			i++;
			continue;
		}
		if (char === ";" || char === "|") {
			flushSegment();
			continue;
		}
		if (char === ">") {
			flushWord();
			if (command[i + 1] === ">") {
				words.push(">>");
				i++;
			} else words.push(">");
			continue;
		}
		current += char;
	}
	flushSegment();
	return segments;
}
