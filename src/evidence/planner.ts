import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import type { ProjectConfig } from "../config/schema.ts";
import type { TaskContract } from "../contract/schema.ts";
import { assessFreshness, changedTargetsSince, evidenceFor } from "../state/freshness.ts";
import type { HarnessState } from "../state/types.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { EvidencePlan, EvidenceRequest } from "./types.ts";

/**
 * The Evidence Planner (§24).
 *
 * Answers one question: *what must be proven before this action may proceed?*
 *
 * The answer comes from the current Task Contract, never from a built-in checklist.
 * There is no "before push, run tests" rule anywhere in this file — if tests matter
 * for this task, they matter because a success condition says so.
 *
 * Planning proceeds in three steps:
 *   1. Skip requirements that fresh evidence already covers. Re-proving what is known
 *      is pure cost.
 *   2. For the rest, derive a request from the contract's own `verificationHint`,
 *      from a machine-checkable `check`, or from project `preferredCommands`.
 *   3. Anything left with no available route is reported as *unverifiable* rather than
 *      silently dropped — the Judge must know a requirement could not be checked.
 */

export interface EvidencePlanner {
	plan(args: {
		contract: TaskContract;
		state: HarnessState;
		checkpoint: CheckpointDecision;
		checkpointId: string;
		action: ProposedAction;
		projectConfig?: ProjectConfig | undefined;
	}): EvidencePlan;
}

export function createEvidencePlanner(options: { logger?: Logger } = {}): EvidencePlanner {
	const log = (options.logger ?? nullLogger).child("evidence:plan");

	return {
		plan({ contract, state, checkpoint, checkpointId, action, projectConfig }): EvidencePlan {
			const targets = resolveTargets(contract, checkpoint);

			const requests: EvidenceRequest[] = [];
			const alreadySatisfied: string[] = [];
			const unverifiable: Array<{ requirementId: string; reason: string }> = [];
			const now = Date.now();

			for (const target of targets) {
				// Step 1 — is it already proven, freshly?
				const existing = evidenceFor(state.evidence, target.id).filter(
					(item) =>
						item.result === "supported" &&
						item.trust === "runtime_evidence" &&
						assessFreshness(item, {
							now,
							currentStateVersion: state.stateVersion,
							changedTargets: changedTargetsSince(state.actions, item.stateVersion),
						}).fresh,
				);
				if (existing.length > 0) {
					alreadySatisfied.push(target.id);
					continue;
				}

				// Step 2 — can we derive a way to check it?
				const derived = deriveRequests(target, contract, projectConfig, action);
				if (derived.length > 0) {
					requests.push(...derived);
					continue;
				}

				// Step 3 — be honest that we cannot.
				unverifiable.push({
					requirementId: target.id,
					reason: target.verificationHint
						? `No executable check could be derived from the verification hint: "${target.verificationHint}"`
						: "The contract provides no verification hint and no project command matches this requirement.",
				});
			}

			// Cheap first, required before optional: an early FAIL should cost as little as possible.
			const costRank = { cheap: 0, moderate: 1, expensive: 2 } as const;
			requests.sort((a, b) => {
				if (a.necessity !== b.necessity) return a.necessity === "required" ? -1 : 1;
				return costRank[a.cost] - costRank[b.cost];
			});

			const plan: EvidencePlan = {
				checkpointId,
				requirementsToVerify: targets.map((t) => t.id),
				evidenceRequests: requests,
				alreadySatisfied,
				unverifiable,
				preferredEvaluators: checkpoint.severity === "critical" ? ["primary", "fallback"] : ["primary"],
			};

			log.info("evidence planned", {
				checkpointId,
				targets: targets.length,
				requests: requests.length,
				satisfied: alreadySatisfied.length,
				unverifiable: unverifiable.length,
			});

			return plan;
		},
	};
}

interface PlanTarget {
	readonly id: string;
	readonly description: string;
	readonly priority: "hard" | "soft";
	readonly verificationHint?: string | undefined;
	readonly check?: { kind: string; target: string } | undefined;
}

/**
 * What this checkpoint requires proving.
 *
 * The contract's own linkage is used when present. A completion claim pulls in every
 * success condition and hard requirement, because §44 says completion is evaluated
 * against the contract as a whole rather than against whatever the worker last touched.
 */
function resolveTargets(contract: TaskContract, checkpoint: CheckpointDecision): PlanTarget[] {
	const wanted = new Set(checkpoint.relatedRequirements);
	const targets = new Map<string, PlanTarget>();

	const addRequirement = (r: (typeof contract.requirements)[number]) =>
		targets.set(r.id, { id: r.id, description: r.description, priority: r.priority });

	const addSuccess = (s: (typeof contract.successConditions)[number]) =>
		targets.set(s.id, {
			id: s.id,
			description: s.description,
			priority: s.priority,
			verificationHint: s.verificationHint,
		});

	const addConstraint = (c: (typeof contract.constraints)[number]) =>
		targets.set(c.id, { id: c.id, description: c.description, priority: c.priority, check: c.check });

	if (checkpoint.checkpointType === "completion_claim") {
		for (const s of contract.successConditions) addSuccess(s);
		for (const r of contract.requirements) if (r.priority === "hard") addRequirement(r);
		for (const c of contract.constraints) if (c.priority === "hard") addConstraint(c);
		return [...targets.values()];
	}

	for (const r of contract.requirements) if (wanted.has(r.id)) addRequirement(r);
	for (const s of contract.successConditions) if (wanted.has(s.id)) addSuccess(s);
	for (const c of contract.constraints) if (wanted.has(c.id)) addConstraint(c);

	// A critical action whose contract entry named no prerequisites still has to
	// answer to the task's hard constraints.
	if (targets.size === 0) {
		for (const c of contract.constraints) if (c.priority === "hard") addConstraint(c);
		for (const r of contract.requirements) if (r.priority === "hard") addRequirement(r);
	}

	return [...targets.values()];
}

/**
 * Turn one requirement into zero or more executable checks.
 *
 * Ordered by reliability: a machine-checkable constraint beats a command extracted
 * from a hint, which beats a project command matched by keyword, which beats asking a
 * reviewer model.
 */
function deriveRequests(
	target: PlanTarget,
	contract: TaskContract,
	projectConfig: ProjectConfig | undefined,
	action: ProposedAction,
): EvidenceRequest[] {
	const requirementIds = [target.id];
	const necessity = target.priority === "hard" ? "required" : "optional";

	// 1. A declared machine check: exact, deterministic, no interpretation.
	if (target.check) {
		return [
			{
				id: newId("evr"),
				requirementIds,
				kind: target.check.kind === "command_exit_zero" ? "command" : "file_state",
				description: `Verify "${target.description}" by checking ${target.check.target}`,
				parameters:
					target.check.kind === "command_exit_zero"
						? { command: target.check.target }
						: { path: target.check.target, mode: target.check.kind },
				necessity,
				cost: "cheap",
				freshnessClass: "until_change",
			},
		];
	}

	/**
	 * 2. A command embedded in the requirement itself.
	 *
	 * The hint is checked first because that is where a well-formed contract puts it.
	 * The description is checked too, because weaker compiler models routinely emit
	 * "Verify the result by running `wc -l data.csv`" as a *requirement* with no hint
	 * at all — and refusing to look there means the command is right in front of us and
	 * every requirement reports as unverifiable.
	 */
	for (const source of [target.verificationHint, target.description]) {
		if (!source) continue;
		const command = extractCommand(source);
		if (command) {
			const expectation = expectedOutput(source, target.description, command);
			return [
				{
					id: newId("evr"),
					requirementIds,
					kind: "command",
					description: `Verify "${target.description}" by running: ${command}`,
					parameters: { command, ...expectation },
					necessity,
					cost: "moderate",
					freshnessClass: "temporary",
				},
			];
		}
	}

	// 3. A project-configured command whose name the requirement mentions.
	const projectCommand = matchProjectCommand(target, projectConfig);
	if (projectCommand) {
		return [
			{
				id: newId("evr"),
				requirementIds,
				kind: "command",
				description: `Verify "${target.description}" using the project's ${projectCommand.name} command`,
				parameters: { command: projectCommand.command },
				necessity,
				cost: "moderate",
				freshnessClass: "temporary",
			},
		];
	}

	// 4. A reviewer judgement, for requirements no command can settle
	//    ("the image is thematically about Kubernetes").
	if (target.verificationHint) {
		return [
			{
				id: newId("evr"),
				requirementIds,
				kind: "reviewer",
				description: `Have a reviewer assess "${target.description}"`,
				parameters: {
					question: target.description,
					hint: target.verificationHint,
					goal: contract.goal,
					proposedAction: action.summary,
				},
				necessity,
				cost: "expensive",
				freshnessClass: "temporary",
			},
		];
	}

	return [];
}

/**
 * Pull a runnable command out of a free-text hint.
 *
 * Recognizes backticks, an explicit "run …", and shell-looking lines. Conservative:
 * a false positive would execute something the user never asked for, so anything that
 * does not clearly look like a command is left to the reviewer path instead.
 */
export function extractCommand(hint: string): string | undefined {
	const backticked = /`([^`\n]{2,200})`/.exec(hint);
	if (backticked?.[1] && looksRunnable(backticked[1])) return backticked[1].trim();

	const explicit = /\brun(?:ning|s)?\s+["']([^"'\n]{2,200})["']/i.exec(hint);
	if (explicit?.[1] && looksRunnable(explicit[1])) return explicit[1].trim();

	const bare = /\brun(?:ning|s)?\s+([a-z0-9_.-]+(?:\s+[a-z0-9_.:/=-]+){0,6})/i.exec(hint);
	if (bare?.[1] && looksRunnable(bare[1])) return bare[1].trim();

	return undefined;
}

/**
 * Reject anything with shell metacharacters that could chain or redirect. Evidence
 * collection runs commands the harness derived, not commands a user reviewed, so the
 * bar for what may run is high.
 */
function expectedOutput(
	hint: string,
	description: string,
	command: string,
): { expectedOutput?: string; outputComparison?: "exact" | "first_token" } {
	const explicit =
		/\b(?:returns?|outputs?|prints?|equals?|expected(?: output)?(?: is|:)?|must (?:be|equal))\s+[`"']?([^`"',.;\s]+)/i.exec(hint);
	if (explicit?.[1]) return { expectedOutput: explicit[1].trim(), outputComparison: "exact" };
	if (/^wc\s+-l\b/i.test(command) && /\b(empty|zero rows?|no rows?)\b/i.test(description)) {
		return { expectedOutput: "0", outputComparison: "first_token" };
	}
	return {};
}

function looksRunnable(candidate: string): boolean {
	const text = candidate.trim();
	if (text.length < 2 || text.length > 200) return false;
	if (/[;&|><$(){}`\n]/.test(text)) return false;
	return /^[a-z0-9_./-]+(\s|$)/i.test(text);
}

function matchProjectCommand(
	target: PlanTarget,
	projectConfig: ProjectConfig | undefined,
): { name: string; command: string } | undefined {
	const commands = projectConfig?.preferredCommands;
	if (!commands) return undefined;

	const haystack = `${target.description} ${target.verificationHint ?? ""}`.toLowerCase();
	for (const [name, command] of Object.entries(commands)) {
		if (haystack.includes(name.toLowerCase())) return { name, command };
	}
	return undefined;
}
