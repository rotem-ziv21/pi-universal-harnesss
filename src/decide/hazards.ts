import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * The deterministic layer in front of Jev. It is small on purpose.
 *
 * It does three things and nothing else:
 *   1. Names a short, closed list of catastrophic commands, which are denied, and a
 *      short list of irreversible-but-legitimate ones, which need the user.
 *   2. Names what it can vouch for as harmless (reads, searches, checks, edits inside
 *      the project), which pass without a Judge call.
 *   3. Sends everything else to Jev, with `hints`: facts it noticed, never a verdict.
 *
 * The previous harness tried to understand every command it saw, and every new
 * command shape broke a rule. Here a command the layer does not recognise is not a
 * bug: it is Jev's job. The only cost of not recognising something is one Jev call.
 */

export type FastVerdict =
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "deny"; readonly reason: string }
	| { readonly kind: "confirm"; readonly reason: string; readonly hints: readonly string[] }
	| { readonly kind: "judge"; readonly hints: readonly string[]; readonly scripts: readonly ScriptExcerpt[] };

export interface ScriptExcerpt {
	readonly path: string;
	readonly content: string;
}

export interface FastContext {
	readonly cwd: string;
	/** Project paths the user declared protected (`.pi/harness.json`). */
	readonly protectedPaths?: readonly string[] | undefined;
}

const READ_TOOLS = new Set(["read", "ls", "grep", "find", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "sh"]);

export function classifyToolCall(toolName: string, input: Record<string, unknown>, context: FastContext): FastVerdict {
	const tool = toolName.toLowerCase();
	if (READ_TOOLS.has(tool)) return { kind: "allow", reason: "read-only tool" };

	if (WRITE_TOOLS.has(tool)) {
		const path = firstString(input, ["path", "file_path", "filePath", "file"]);
		if (!path) return { kind: "judge", hints: ["a write with no path argument"], scripts: [] };
		const absolute = resolve(context.cwd, expandHome(path));
		const protectedHit = protectedMatch(absolute, context);
		if (protectedHit) return { kind: "confirm", reason: `writes to a protected path (${protectedHit})`, hints: [`protected path: ${protectedHit}`] };
		if (insideWorkspace(absolute, context.cwd)) return { kind: "allow", reason: "edit inside the workspace" };
		return { kind: "judge", hints: [`writes outside the workspace: ${absolute}`], scripts: [] };
	}

	if (SHELL_TOOLS.has(tool)) {
		const command = firstString(input, ["command", "cmd", "script"]);
		if (!command?.trim()) return { kind: "allow", reason: "empty command" };
		return classifyCommand(command, context);
	}

	// A tool the harness has no knowledge of. Jev reads its arguments.
	return { kind: "judge", hints: [`tool "${toolName}" is not a built-in tool`], scripts: [] };
}

export function classifyCommand(command: string, context: FastContext): FastVerdict {
	// Seen whole, because the split would cut it apart.
	if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(command)) return { kind: "deny", reason: "fork bomb" };
	const { segments, bodies } = splitWithHeredocs(command);
	const hints: string[] = [];
	const scripts: ScriptExcerpt[] = [];
	let needsJudge = false;
	// Segments are split on pipes, so a download piped into a shell is seen whole here.
	let confirm: string | undefined = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(command) ? "downloads a script and runs it" : undefined;

	for (const [index, segment] of segments.entries()) {
		const words = tokenize(segment);
		const argv = stripEnvAssignments(words);
		if (argv.length === 0) continue;

		const deny = denyReason(argv);
		if (deny) return { kind: "deny", reason: deny };

		const needsUser = confirmReason(argv);
		if (needsUser && !confirm) confirm = needsUser;

		for (const target of redirectTargets(segment)) {
			if (!insideWorkspace(resolve(context.cwd, expandHome(target)), context.cwd)) {
				hints.push(`redirects output to a file outside the workspace: ${target}`);
				needsJudge = true;
			}
		}
		if (/\$\(|`/.test(segment)) {
			hints.push("uses command substitution, so the executed command is not visible");
			needsJudge = true;
		}

		for (const path of absolutePaths(argv.slice(1))) {
			if (!insideWorkspace(resolve(context.cwd, expandHome(path)), context.cwd) && !isReadOnly(argv)) {
				hints.push(`touches a path outside the workspace: ${path}`);
				needsJudge = true;
			}
		}

		if (isReadOnly(argv) || isCheckCommand(argv) || isHarmlessLocal(argv, context)) continue;

		needsJudge = true;
		const hint = segmentHint(argv);
		if (hint) hints.push(hint);
		const body = bodies.get(index);
		const script = body !== undefined ? { path: "(inline here-document)", content: clipScript(body) } : localScript(argv, context.cwd);
		if (script) scripts.push(script);
	}

	if (confirm) return { kind: "confirm", reason: confirm, hints };
	if (!needsJudge) return { kind: "allow", reason: "read-only or routine local command" };
	return { kind: "judge", hints: unique(hints), scripts };
}

// --- the closed lists ---

/** Catastrophic, cheap to name, never legitimate for an agent to run unattended. */
function denyReason(argv: readonly string[]): string | undefined {
	if (argv[0] === "sudo" && argv.length > 1) return denyReason(argv.slice(1).filter((a, i) => i > 0 || !a.startsWith("-")));
	const [cmd] = argv;
	if (cmd === "rm" && hasFlag(argv, "r") && argv.slice(1).some((a) => /^(\/|\/\*|~\/?|\$HOME\/?|\.\.?\/?\*?)$/.test(a))) {
		return "recursive delete of the filesystem root, the home directory, or the whole working tree";
	}
	if (cmd === "mkfs" || cmd?.startsWith("mkfs.")) return "formats a filesystem";
	if (cmd === "dd" && argv.some((a) => /^of=\/dev\//.test(a))) return "writes directly to a device";
	if (cmd === "chmod" && hasFlag(argv, "R") && argv.includes("/")) return "recursive permission change on the filesystem root";
	return undefined;
}

/** Irreversible or outward, but sometimes exactly what the user wants. The user decides. */
function confirmReason(argv: readonly string[]): string | undefined {
	const [cmd, sub] = argv;
	if (cmd === "sudo") return "runs a command with root privileges";
	if (cmd === "git") {
		if (sub === "push" && argv.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
			return "force-pushes, which rewrites shared history";
		}
		if (sub === "push") return "pushes to a shared remote";
		if (sub === "reset" && argv.includes("--hard")) return "discards uncommitted changes (git reset --hard)";
		if (sub === "clean" && argv.some((a) => /^-[a-zA-Z]*f/.test(a))) return "deletes untracked files (git clean)";
		if (sub === "stash" && (argv[2] === "drop" || argv[2] === "clear")) return "deletes stashed work";
		if (sub === "branch" && argv.some((a) => a === "-D")) return "force-deletes a branch";
		if ((sub === "checkout" && argv.includes("--")) || (sub === "restore" && !argv.includes("--staged"))) {
			return "discards uncommitted changes to files";
		}
	}
	if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && sub === "publish") return "publishes a package";
	return undefined;
}

// --- what the layer can vouch for ---

const READ_ONLY = new Set([
	"ls", "cat", "head", "tail", "wc", "grep", "rg", "ag", "pwd", "echo", "printf", "which", "whereis", "type", "file",
	"stat", "du", "df", "tree", "sort", "uniq", "cut", "tr", "diff", "cmp", "jq", "yq", "less", "more", "basename",
	"dirname", "realpath", "readlink", "date", "whoami", "uname", "hostname", "id", "true", "false", "test", "[", "cd",
	"env", "printenv", "column", "nl", "fold", "od", "xxd", "hexdump", "sha256sum", "shasum", "md5sum", "md5", "ps",
	"lsof", "sleep", "seq", "man", "help",
]);

const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "remote", "config", "grep", "reflog", "cat-file", "ls-tree", "whatchanged"]);
const GIT_LOCAL = new Set(["add", "commit", "fetch", "stash", "switch", "init", "mv", "rm", "tag", "merge", "rebase", "cherry-pick", "pull", "branch", "checkout"]);

function isReadOnly(argv: readonly string[]): boolean {
	const [cmd, sub] = argv;
	if (!cmd) return true;
	if (cmd === "find") return !argv.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok");
	if (cmd === "sed") return !argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
	if (cmd === "git") return sub !== undefined && GIT_READ.has(sub) && !(sub === "config" && argv.length > 3) && !(sub === "remote" && argv.length > 2 && argv[2] !== "-v");
	if (cmd === "curl" || cmd === "wget") return isPlainFetch(argv) || onlyLocalhost(argv);
	if ((cmd === "node" || cmd === "python" || cmd === "python3" || cmd === "npm" || cmd === "go" || cmd === "cargo") && (sub === "--version" || sub === "-v" || sub === "-V" || sub === "version")) return true;
	if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && (sub === "ls" || sub === "list" || sub === "view" || sub === "outdated" || sub === "why")) return true;
	return READ_ONLY.has(cmd);
}

/** A GET with no upload flags. Downloading is not an outward effect. */
function isPlainFetch(argv: readonly string[]): boolean {
	const upload = argv.some(
		(a, i) =>
			a === "-d" || a.startsWith("--data") || a === "-F" || a.startsWith("--form") || a === "-T" || a === "--upload-file" ||
			a === "--post-data" || a === "--post-file" || a === "--method" ||
			((a === "-X" || a === "--request") && !/^(GET|HEAD)$/i.test(argv[i + 1] ?? "")),
	);
	return !upload;
}

/** Requests to this machine's own servers are local work, whatever the method. */
function onlyLocalhost(argv: readonly string[]): boolean {
	const urls = argv.filter((a) => /^[a-z]+:\/\//i.test(a) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(a));
	return urls.length > 0 && urls.every((u) => /^([a-z]+:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(u));
}

/** Tests, builds, typechecks, linters: running them is how work gets verified, never a hazard. */
export function isCheckCommand(argv: readonly string[]): boolean {
	const [cmd, sub, third] = argv;
	if (!cmd) return false;
	if (["pytest", "jest", "vitest", "mocha", "tsc", "eslint", "ruff", "mypy", "pyright", "flake8", "black", "prettier", "biome", "rspec", "phpunit", "ctest", "tox", "nox"].includes(cmd)) return true;
	if ((cmd === "python" || cmd === "python3") && sub === "-m" && ["pytest", "unittest", "mypy", "ruff", "compileall", "py_compile"].includes(third ?? "")) return true;
	if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
		if (sub === "test" || sub === "t") return true;
		if (sub === "run" && /^(test|build|check|lint|typecheck|type-check|tsc|verify|ci)([:-].*)?$/.test(third ?? "")) return true;
		if (cmd !== "npm" && /^(test|build|check|lint|typecheck)([:-].*)?$/.test(sub ?? "")) return true;
	}
	if (cmd === "npx" && ["tsc", "jest", "vitest", "eslint", "mocha", "prettier", "biome"].includes(sub ?? "")) return true;
	if (cmd === "cargo" && ["test", "build", "check", "clippy", "fmt"].includes(sub ?? "")) return true;
	if (cmd === "go" && ["test", "build", "vet"].includes(sub ?? "")) return true;
	if (cmd === "make" && ["test", "check", "build", "lint"].includes(sub ?? "")) return true;
	if ((cmd === "gradle" || cmd === "./gradlew" || cmd === "mvn") && argv.some((a) => /^(test|build|check|verify|compile)$/.test(a))) return true;
	if (cmd === "node" && sub === "--test") return true;
	if (cmd === "dotnet" && ["test", "build"].includes(sub ?? "")) return true;
	return false;
}

/** Local and reversible: creating things, local git, deleting generated output. */
function isHarmlessLocal(argv: readonly string[], context: FastContext): boolean {
	const [cmd, sub] = argv;
	if (!cmd) return true;
	if (cmd === "mkdir" || cmd === "touch") return argv.slice(1).every((a) => a.startsWith("-") || insideWorkspace(resolve(context.cwd, expandHome(a)), context.cwd));
	if (cmd === "git" && sub && GIT_LOCAL.has(sub)) return true;
	if (cmd === "tee") return argv.slice(1).every((a) => a.startsWith("-") || a === "/dev/null" || insideWorkspace(resolve(context.cwd, expandHome(a)), context.cwd));
	if (cmd === "rm") {
		const targets = argv.slice(1).filter((a) => !a.startsWith("-"));
		// Temp is scratch only outside the project: a project that lives under /tmp is still the project.
		return targets.length > 0 && targets.every((t) => {
			const absolute = resolve(context.cwd, expandHome(t));
			return isGenerated(t) || (isTemp(absolute) && !isUnder(absolute, context.cwd));
		});
	}
	return false;
}

const GENERATED = /(^|\/)(node_modules|dist|build|out|target|coverage|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|\.turbo|\.parcel-cache|tmp|\.tmp)(\/.*)?$|\.(pyc|log|tmp|o)$/;
const isGenerated = (path: string): boolean => GENERATED.test(path.replace(/\/+$/, ""));

function segmentHint(argv: readonly string[]): string | undefined {
	const [cmd] = argv;
	if (cmd === "rm") return hasFlag(argv, "r") ? "recursive delete" : "deletes files";
	if (cmd === "mv") return "moves or renames files, which can overwrite a target";
	if (cmd === "curl" || cmd === "wget") return "network request that sends data or uses a non-GET method";
	if (cmd === "scp" || cmd === "rsync" || cmd === "ssh" || cmd === "sftp" || cmd === "nc") return "remote transfer or remote shell";
	if (cmd === "chmod" || cmd === "chown") return "changes permissions or ownership";
	if (cmd === "docker" || cmd === "kubectl" || cmd === "terraform" || cmd === "aws" || cmd === "gcloud" || cmd === "az") return "infrastructure or container command";
	if (cmd === "eval") return "evaluates a string as a command";
	return undefined;
}

/** The body of a local script the command runs, so Jev judges what it does, not its name. */
function localScript(argv: readonly string[], cwd: string): ScriptExcerpt | undefined {
	const [cmd, first] = argv;
	const candidate = ["bash", "sh", "zsh", "python", "python3", "node", "tsx", "ts-node", "ruby", "perl"].includes(cmd ?? "") ? first : cmd;
	if (!candidate || candidate.startsWith("-") || !/[./]/.test(candidate)) return undefined;
	const path = resolve(cwd, expandHome(candidate));
	try {
		if (!statSync(path).isFile()) return undefined;
		const content = readFileSync(path, "utf8");
		return { path: candidate, content: clipScript(content) };
	} catch {
		return undefined;
	}
}

const clipScript = (content: string): string => (content.length > 3000 ? `${content.slice(0, 3000)}\n…(truncated)` : content);

// --- shell text handling ---

/**
 * Split a command line into simple commands on `&&`, `||`, `;`, `|`, `&` and
 * newlines, outside quotes. Not a shell parser; it only needs to find the
 * commands so each can be looked at.
 */
export function splitCommand(command: string): string[] {
	return splitWithHeredocs(command).segments;
}

/**
 * The same split, plus the bodies of here-documents (`<<'EOF' … EOF`). A body is
 * data for the command before it, not a command of its own, so it is kept apart:
 * the classifier must not read `import re` as a program, and Jev should see the
 * inline script a `python3 - <<'PY'` runs.
 */
export function splitWithHeredocs(command: string): { segments: string[]; bodies: Map<number, string> } {
	const segments: string[] = [];
	const bodies = new Map<number, string>();
	const lines = command.split("\n");
	let pending: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const before = segments.length;
		for (const part of splitLine(line)) segments.push(part);
		pending = [];
		const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) pending.push(m[2]!);
		for (const tag of pending) {
			const body: string[] = [];
			while (i + 1 < lines.length && lines[i + 1]!.trim() !== tag) body.push(lines[++i]!);
			if (i + 1 < lines.length) i++; // the terminator
			const owner = Math.max(before, segments.length - 1);
			bodies.set(owner, [bodies.get(owner), body.join("\n")].filter(Boolean).join("\n"));
		}
	}
	return { segments, bodies };
}

/** Split one line on `&&`, `||`, `;`, `|` and `&`, outside quotes. */
function splitLine(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		const next = command[i + 1];
		const isRedirectAmp = ch === "&" && (command[i - 1] === ">" || next === ">");
		if (ch === ";" || ((ch === "|" || ch === "&") && !isRedirectAmp)) {
			if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) i++;
			if (current.trim()) out.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

/** Words of one simple command, quotes removed. */
export function tokenize(segment: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) words.push(current);
	// Redirections are not arguments.
	return words.filter((w, i, all) => !/^\d*>>?&?\d*$/.test(w) && !/^\d*[<>]/.test(w) && !/^\d*>>?$/.test(all[i - 1] ?? ""));
}

function stripEnvAssignments(words: string[]): string[] {
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
	const rest = words.slice(i);
	// `command`, `time`, `nohup` and similar wrap the real command.
	while (rest.length > 1 && ["time", "nohup", "command", "exec", "nice"].includes(rest[0]!)) rest.shift();
	return rest;
}

function redirectTargets(segment: string): string[] {
	const out: string[] = [];
	const re = /(?:^|[^<>&\d])\d*>>?\s*([^\s&|;]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(segment))) {
		const target = m[1]!.replace(/^["']|["']$/g, "");
		if (target.startsWith("&") || target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr") continue;
		out.push(target);
	}
	return out;
}

function absolutePaths(args: readonly string[]): string[] {
	return args.filter((a) => !a.startsWith("-") && (isAbsolute(a) || a.startsWith("~/") || a === "~" || a.startsWith("$HOME")) && !a.startsWith("/dev/"));
}

function hasFlag(argv: readonly string[], letter: string): boolean {
	return argv.some((a) => (/^-[a-zA-Z]+$/.test(a) && a.includes(letter)) || (letter === "r" && a === "--recursive") || (letter === "R" && a === "--recursive"));
}

// --- paths ---

const TEMP_ROOTS = unique([tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/folders", "/var/folders"]);

export function insideWorkspace(absolute: string, cwd: string): boolean {
	return isUnder(absolute, cwd) || isTemp(absolute);
}

function isTemp(absolute: string): boolean {
	return TEMP_ROOTS.some((root) => isUnder(absolute, root));
}

function isUnder(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function protectedMatch(absolute: string, context: FastContext): string | undefined {
	for (const entry of context.protectedPaths ?? []) {
		const target = resolve(context.cwd, expandHome(entry));
		if (isUnder(absolute, target)) return entry;
	}
	const rel = relative(context.cwd, absolute);
	if (rel === ".git" || rel.startsWith(".git/")) return ".git";
	return undefined;
}

function expandHome(path: string): string {
	const home = process.env.HOME ?? "";
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
	if (path.startsWith("$HOME")) return `${home}${path.slice(5)}`;
	return path;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function unique<T>(items: readonly T[]): T[] {
	return [...new Set(items)];
}
