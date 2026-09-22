import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ResourceEffect,
	ResourceKind,
	ResourceOperation,
	ResourceProvenance,
	ResourceRecord,
	ResourceScope,
	TaskWorkspaceState,
	WorkspacePolicy,
} from "./types.ts";

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function createWorkspaceState(initialWorkingDirectory: string, policy: WorkspacePolicy = {}): TaskWorkspaceState {
	const cwd = resolve(initialWorkingDirectory);
	const allowed = policy.allowedScopes?.length ? policy.allowedScopes : [cwd];
	return {
		initialWorkingDirectory: cwd,
		allowedScopes: allowed.map((entry) => normalizeScopeUri(entry, cwd)),
		protectedResources: (policy.protectedResources ?? []).map((entry) => normalizeScopeUri(entry, cwd)),
		resources: [],
	};
}

export function resourceUri(reference: string, cwd: string): string {
	if (URI_SCHEME.test(reference)) {
		if (reference.startsWith("file:")) return pathToFileURL(resolve(fileURLToPath(reference))).href;
		return reference;
	}
	return pathToFileURL(isAbsolute(reference) ? resolve(reference) : resolve(cwd, reference)).href;
}

export function resourcePath(uri: string): string | undefined {
	if (!uri.startsWith("file:")) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

export function resourceScope(uri: string, workspace: TaskWorkspaceState): ResourceScope {
	if (!uri.startsWith("file:")) return "external";
	if (workspace.protectedResources.some((scope) => uriWithin(uri, scope))) return "protected";
	if (workspace.allowedScopes.some((scope) => uriWithin(uri, scope))) return "allowed";
	/**
	 * The system temp directory is scratch space for every tool and every worker.
	 * Treating it as "outside the workspace" turned `curl -o /tmp/page.html` into a
	 * policy violation, which is not a rule anyone meant. It stays overridable: a
	 * contract or project config can still name a temp path as protected.
	 */
	if (TEMP_SCOPES.some((scope) => uriWithin(uri, scope))) return "allowed";
	return "outside_allowed";
}

const TEMP_SCOPES: readonly string[] = (() => {
	// Both spellings of each directory: a URI built from a literal path (`/tmp/x`)
	// and one built from its canonical form (`/private/tmp/x` on macOS) must both count.
	const dirs = new Set<string>();
	for (const candidate of [tmpdir(), "/tmp"]) {
		const literal = resolve(candidate);
		dirs.add(`${pathToFileURL(literal).href}/`);
		try {
			dirs.add(`${pathToFileURL(realpathSync(literal)).href}/`);
		} catch {
			// Not present on this platform; the literal form is enough.
		}
	}
	return [...dirs];
})();

export function registeredResource(uri: string, workspace: TaskWorkspaceState): ResourceRecord | undefined {
	return workspace.resources.find((resource) => resource.uri === uri);
}

export function resourceProvenance(
	uri: string,
	operation: ResourceOperation,
	workspace: TaskWorkspaceState,
	createdByHarness = false,
): ResourceProvenance {
	const registered = registeredResource(uri, workspace);
	if (registered) return registered.provenance;
	if (createdByHarness) return "created_by_harness";
	if (!uri.startsWith("file:")) return "external";
	const path = resourcePath(uri);
	if (path && existsSync(path)) return "preexisting";
	if (operation === "create") return "created_by_current_task";
	return "unknown";
}

export function materializeResourceEffect(args: {
	reference: string;
	cwd: string;
	kind: ResourceKind;
	operation: ResourceOperation;
	workspace: TaskWorkspaceState;
	reversible: boolean;
	external?: boolean;
	metadata?: Readonly<Record<string, unknown>>;
}): ResourceEffect {
	const uri = resourceUri(args.reference, args.cwd);
	const scope = resourceScope(uri, args.workspace);
	const provenance = resourceProvenance(uri, args.operation, args.workspace);
	return {
		uri,
		kind: args.kind,
		operation: args.operation,
		provenance,
		scope,
		reversible: args.reversible,
		external: args.external ?? scope === "external",
		...(args.metadata ? { metadata: args.metadata } : {}),
	};
}

export function applyResourceEffects(
	workspace: TaskWorkspaceState,
	effects: readonly ResourceEffect[],
	actionId: string,
	at: string,
): TaskWorkspaceState {
	if (effects.length === 0) return workspace;
	const resources = new Map(workspace.resources.map((resource) => [resource.uri, resource]));
	for (const effect of effects) {
		if (effect.operation === "read" || effect.operation === "query" || effect.operation === "execute") continue;
		const previous = resources.get(effect.uri);
		const provenance = previous?.provenance ?? effect.provenance;
		resources.set(effect.uri, {
			uri: effect.uri,
			kind: effect.kind,
			provenance,
			scope: effect.scope,
			status: effect.operation === "delete" ? "deleted" : "active",
			...(!previous && provenance === "created_by_current_task" ? { createdByActionId: actionId } : {}),
			...(previous?.createdByActionId ? { createdByActionId: previous.createdByActionId } : {}),
			lastActionId: actionId,
			lastOperation: effect.operation,
			updatedAt: at,
			...(effect.metadata ? { metadata: effect.metadata } : previous?.metadata ? { metadata: previous.metadata } : {}),
		});
	}
	return { ...workspace, resources: [...resources.values()] };
}

function normalizeScopeUri(reference: string, cwd: string): string {
	const uri = resourceUri(reference, cwd);
	return uri.endsWith("/") ? uri : `${uri}/`;
}

function uriWithin(uri: string, scope: string): boolean {
	if (uri === scope.slice(0, -1)) return true;
	if (uri.startsWith(scope)) return true;
	const targetPath = resourcePath(uri);
	const scopePath = resourcePath(scope);
	if (!targetPath || !scopePath) return false;
	const rel = relative(scopePath, targetPath);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
