import { withActionSemantics } from "../checkpoints/action-semantics.ts";
import type { CheckpointDetector } from "../checkpoints/detector.ts";
import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import type { HarnessPaths } from "../config/paths.ts";
import type { HarnessConfig, ProjectConfig } from "../config/schema.ts";
import type { TaskContract } from "../contract/schema.ts";
import type { EvidenceCollector } from "../evidence/collector.ts";
import { evaluateCompletionConditions } from "../evidence/completion.ts";
import { analyzeGateDependency } from "../evidence/dependency.ts";
import type { EvidencePlanner } from "../evidence/planner.ts";
import type { EvidencePlan } from "../evidence/types.ts";
import { isStale } from "../judges/judge.ts";
import { buildJudgeQuery, estimatePayloadTokens } from "../judges/payload.ts";
import type { JudgeRouter, RoutedDecision } from "../judges/router.ts";
import type { ProgressMonitor } from "../progress/monitor.ts";
import type { StateManager } from "../state/state-manager.ts";
import type { CheckpointRecord, CompletionConditionResult, EvidenceRef } from "../state/types.ts";
import { newCheckpointId, newDecisionId, newEvidenceId, nowIso } from "../util/ids.ts";
import type { Logger } from "../util/logger.ts";
import { renderBlock, renderCompletionRejection } from "./render.ts";

/**
 * The gate.
 *
 * This is the §45 pipeline, in one place:
 *
 *   proposed action → checkpoint detection → evidence planning → evidence collection
 *                   → Judge → allow / block
 *
 * Deliberately independent of Pi: it takes a `ProposedAction` and returns a
 * `GateOutcome`. `extension.ts` adapts Pi's `tool_call` event to it. That separation
 * is what makes the whole pipeline testable without a running agent, and what would
 * let the harness be ported to another host.
 */

export interface GateOutcome {
	readonly allowed: boolean;
	/** Shown to the user and returned to the model as the block reason. */
	readonly message?: string;
	readonly decision?: RoutedDecision;
	readonly checkpoint?: CheckpointDecision;
	readonly plan?: EvidencePlan;
	/** True when the worker should stop rather than retry (§43 STOP_BRANCH). */
	readonly terminate?: boolean;
}

export interface HarnessCore {
	gateAction(args: {
		action: ProposedAction;
		cwd: string;
		agentAssessment?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<GateOutcome>;

	gateCompletion(args: {
		cwd: string;
		agentAssessment?: string | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<GateOutcome>;

	recordToolResult(args: { actionId: string; summary: string; isError: boolean }): void;
	observeTurn(): void;
}

export interface HarnessCoreDeps {
	readonly config: HarnessConfig;
	readonly paths: HarnessPaths;
	readonly state: StateManager;
	readonly detector: CheckpointDetector;
	readonly planner: EvidencePlanner;
	readonly collector: EvidenceCollector;
	readonly judge: JudgeRouter;
	readonly progress: ProgressMonitor;
	readonly logger: Logger;
	readonly projectConfig?: ProjectConfig | undefined;
	/** Surfaces a REVIEW verdict to the user. Absent in non-interactive modes. */
	readonly confirmWithUser?: ((title: string, message: string) => Promise<boolean>) | undefined;
}

export function createHarnessCore(deps: HarnessCoreDeps): HarnessCore {
	const log = deps.logger.child("gate");

	return {
		async gateAction({ action, cwd, agentAssessment, signal }): Promise<GateOutcome> {
			const contract = deps.state.getContract();
			const normalizedAction = withActionSemantics(action, {
				cwd,
				contract,
				state: deps.state.getState(),
			});
			const state = deps.state.getState();

			deps.state.recordProposedAction({
				id: normalizedAction.id,
				toolName: normalizedAction.toolName,
				summary: normalizedAction.summary,
				signature: normalizedAction.signature,
				actionSemantics: normalizedAction.actionSemantics,
				at: nowIso(),
				stateVersion: state.stateVersion,
				outcome: "pending",
			});

			const progress = deps.progress.observeAction({
				contract,
				state: deps.state.getState(),
				action: normalizedAction,
			});
			if (progress.action === "STOP_BRANCH") {
				deps.state.emit("branch_stopped", {
					reason: progress.reason,
					detail: progress.detail,
					actionId: normalizedAction.id,
				});
				deps.state.recordBlocked(normalizedAction.id, progress.reason);
				return {
					allowed: false,
					terminate: true,
					message: `BLOCKED — ${progress.reason}${progress.contractItemId ? `\n\nThis is a hard user constraint (${progress.contractItemId}), not a harness heuristic.` : ""}`,
				};
			}
			if (progress.action === "CHANGE_STRATEGY") {
				deps.state.emit("progress_observation", { observation: progress, actionId: normalizedAction.id });
				log.info("progress advice issued", { reason: progress.reason });
			}

			const checkpoint = await deps.detector.evaluate({
				contract,
				state: deps.state.getState(),
				action: normalizedAction,
				protectedPaths: deps.projectConfig?.protectedPaths ?? [],
				...(signal ? { signal } : {}),
			});

			if (!checkpoint.needsGate) {
				deps.state.recordAllowed(normalizedAction.id);
				return { allowed: true, checkpoint };
			}

			if (checkpoint.policyDecision === "block") {
				const checkpointId = recordCheckpoint(deps, normalizedAction, checkpoint);
				const constraintId = checkpoint.relatedRequirements[0];
				const message = [
					"Action rejected: the normalized tool operation violates a hard constraint.",
					"",
					`Action: ${normalizedAction.actionSemantics.actionType}`,
					...(normalizedAction.actionSemantics.target ? [`Path: ${normalizedAction.actionSemantics.target}`] : []),
					...(constraintId ? [`Constraint: ${constraintId}`] : []),
					`Reason: ${checkpoint.reason}`,
				].join("\n");
				deps.state.recordBlocked(normalizedAction.id, checkpoint.reason, checkpointId);
				return { allowed: false, message, checkpoint };
			}

			const retry = deps.progress.observeCheckpoint({
				state: deps.state.getState(),
				action: normalizedAction,
				checkpoint,
			});
			if (retry.action === "NO_PROGRESS") {
				deps.state.recordBlocked(normalizedAction.id, retry.reason);
				return { allowed: false, message: `NO_PROGRESS\n\nReason: ${retry.reason}`, checkpoint };
			}

			return runGate({ deps, log, action: normalizedAction, checkpoint, contract, cwd, agentAssessment, signal });
		},

		/**
		 * The completion gate (§44).
		 *
		 * The worker cannot declare "task completed" and bypass verification: this runs
		 * from Pi's `agent_settled` event, which fires when Pi will not continue on its
		 * own. A rejection is pushed back as a message that triggers a new turn, so the
		 * worker resumes with structured feedback rather than stopping.
		 */
		async gateCompletion({ cwd, agentAssessment, signal }): Promise<GateOutcome> {
			const contract = deps.state.getContract();
			deps.state.requestCompletion();

			const evaluation = evaluateCompletionConditions({ contract, state: deps.state.getState() });
			deps.state.recordCompletionEvaluation(evaluation);
			const hardUnsatisfied = evaluation.conditions.filter(
				(condition) => condition.priority === "hard" && condition.status === "UNSATISFIED",
			);
			const hardUnknown = evaluation.conditions.filter(
				(condition) => condition.priority === "hard" && condition.status === "UNKNOWN",
			);

			if (hardUnsatisfied.length > 0) {
				const message = completionConditionMessage("UNSATISFIED", hardUnsatisfied);
				deps.state.rejectCompletion(message);
				return { allowed: false, message };
			}
			if (hardUnknown.length === 0) {
				deps.state.completeTask();
				return { allowed: true };
			}

			const detected = deps.detector.evaluateCompletion({ contract, state: deps.state.getState() });
			const checkpoint: CheckpointDecision = {
				...detected,
				relatedRequirements: hardUnknown.map((condition) => condition.id),
			};
			const action: ProposedAction = {
				id: `completion-${deps.state.getVersion()}`,
				toolName: "(completion)",
				input: {},
				actionSemantics: {
					actionType: "unknown",
					classification: "known",
					mutationType: "none",
					reversibility: "high",
					externalSideEffect: false,
					capabilities: [],
					effects: [],
					targetProvenance: "unknown",
					targetScope: "unknown",
					operationText: "completion",
				},
				summary: "Declare the task complete",
				signature: "completion",
			};

			const outcome = await runGate({
				deps,
				log,
				action,
				checkpoint,
				contract,
				cwd,
				agentAssessment,
				signal,
				renderRejection: true,
			});

			if (outcome.allowed) {
				deps.state.completeTask();
				log.info("task completed and verified", { taskId: deps.state.taskId, stateVersion: deps.state.getVersion() });
			} else {
				deps.state.rejectCompletion(outcome.message ?? "Completion was rejected.");
			}
			return outcome;
		},

		recordToolResult({ actionId, summary, isError }): void {
			recordRuntimeToolEvidence(deps, actionId, summary, isError);
		},

		observeTurn(): void {
			const observation = deps.progress.observeTurn({
				contract: deps.state.getContract(),
				state: deps.state.getState(),
			});
			if (observation.action !== "CONTINUE") {
				deps.state.emit("progress_observation", { observation, turns: deps.state.getState().counters.turns + 1 });
			} else {
				deps.state.emit("progress_observation", { turns: deps.state.getState().counters.turns + 1 });
			}
		},
	};
}

/** Plan → collect → judge → decide. Shared by the action gate and the completion gate. */
async function runGate(args: {
	deps: HarnessCoreDeps;
	log: Logger;
	action: ProposedAction;
	checkpoint: CheckpointDecision;
	contract: TaskContract;
	cwd: string;
	agentAssessment?: string | undefined;
	signal?: AbortSignal | undefined;
	renderRejection?: boolean;
}): Promise<GateOutcome> {
	const { deps, log, action, checkpoint, contract, cwd, agentAssessment, signal } = args;

	const checkpointId = newCheckpointId();
	const plan = deps.planner.plan({
		contract,
		state: deps.state.getState(),
		checkpoint,
		checkpointId,
		action,
		projectConfig: deps.projectConfig,
	});
	const dependency = analyzeGateDependency(plan, action, contract);
	recordCheckpoint(deps, action, checkpoint, checkpointId, dependency);
	deps.state.emit("evidence_requested", { checkpointId, plan, dependency });

	if (dependency.dependsOnBlockedAction) {
		deps.state.recordAllowed(action.id, checkpointId);
		log.info("checkpoint bypassed to avoid circular evidence dependency", {
			checkpointId,
			requirements: dependency.requirementIds,
		});
		return { allowed: true, checkpoint, plan };
	}

	if (plan.evidenceRequests.length > 0) {
		const result = await deps.collector.collect({ plan, cwd, state: deps.state.getState(), ...(signal ? { signal } : {}) });
		const evidenceStateVersion = deps.state.getVersion() + result.collected.length;
		for (const item of result.collected) {
			const evidence: EvidenceRef = {
				id: newEvidenceId(),
				requirementIds: item.requirementIds,
				type: item.type,
				summary: item.summary,
				sourceType: item.sourceType,
				source: item.source,
				observedAt: nowIso(),
				stateVersion: evidenceStateVersion,
				freshnessClass: item.freshnessClass,
				trust: item.trust,
				result: item.result,
				...(item.validity ? { validity: item.validity } : {}),
				observed: item.observed,
				...(item.expected === undefined ? {} : { expected: item.expected }),
				provenance: item.provenance,
				value: item.value,
			};
			deps.state.addEvidence(evidence);
		}

		if (result.failed.length > 0) {
			log.warn("some evidence could not be collected", { checkpointId, failed: result.failed.length });
		}
	}

	let checkpointForJudge = checkpoint;
	if (checkpoint.checkpointType === "completion_claim") {
		const evaluation = evaluateCompletionConditions({ contract, state: deps.state.getState() });
		deps.state.recordCompletionEvaluation(evaluation);
		const hardUnsatisfied = evaluation.conditions.filter(
			(condition) => condition.priority === "hard" && condition.status === "UNSATISFIED",
		);
		if (hardUnsatisfied.length > 0) {
			const message = completionConditionMessage("UNSATISFIED", hardUnsatisfied);
			deps.state.recordBlocked(action.id, "deterministic completion failure", checkpointId);
			return { allowed: false, message, checkpoint, plan };
		}
		const hardUnknown = evaluation.conditions.filter(
			(condition) => condition.priority === "hard" && condition.status === "UNKNOWN",
		);
		if (hardUnknown.length === 0) {
			deps.state.recordAllowed(action.id, checkpointId);
			return { allowed: true, checkpoint, plan };
		}
		checkpointForJudge = { ...checkpoint, relatedRequirements: hardUnknown.map((condition) => condition.id) };
	}

	// --- judge ---
	// The version is captured *after* evidence collection, because collecting evidence
	// advances state. A decision must reference the state it actually saw (§20).
	const stateVersionAtQuery = deps.state.getVersion();

	const query = buildJudgeQuery({
		contract,
		state: deps.state.getState(),
		checkpoint: checkpointForJudge,
		action,
		...(agentAssessment ? { agentAssessment } : {}),
		...(signal ? { signal } : {}),
	});

	deps.state.emit("judge_requested", {
		checkpointId,
		stateVersion: stateVersionAtQuery,
		requirements: query.requirements.length,
		constraints: query.constraints.length,
		estimatedTokens: estimatePayloadTokens(query),
	});

	const decision = await deps.judge.evaluate(query, checkpointForJudge.severity);
	const decisionId = newDecisionId();

	/**
	 * §20/§65.19 — stale decision rejection.
	 *
	 * If state advanced while the Judge was thinking, its verdict describes a world
	 * that no longer exists. Recorded but not applied; the gate then fails safe rather
	 * than acting on it.
	 */
	const currentVersion = deps.state.getVersion();
	const stale = isStale({ ...decision, stateVersion: stateVersionAtQuery }, currentVersion);

	deps.state.recordJudgeDecision({
		id: decisionId,
		checkpointId,
		judgeId: decision.judgeId,
		decision: stale ? "STALE_DECISION" : decision.decision,
		confidence: decision.confidence,
		reasons: decision.reasons,
		missingEvidence: decision.missingEvidence,
		stateVersion: stateVersionAtQuery,
		at: nowIso(),
		...(decision.detail ? { detail: decision.detail } : {}),
		...(decision.debug ? { debug: decision.debug } : {}),
		...(decision.latencyMs !== undefined ? { latencyMs: decision.latencyMs } : {}),
		applied: !stale,
		...(stale ? { staleReason: `computed against v${stateVersionAtQuery}, state is now v${currentVersion}` } : {}),
	});

	if (stale) {
		deps.state.rejectStaleDecision(decisionId, `computed against v${stateVersionAtQuery}, state is now v${currentVersion}`);
		log.warn("rejected a stale judge decision", { decisionId, queried: stateVersionAtQuery, current: currentVersion });

		const message = [
			"BLOCKED — the Judge's decision was stale and was not applied.",
			"",
			`The decision was computed against state v${stateVersionAtQuery}, but state has since advanced to v${currentVersion}.`,
			"Acting on it would be a decision made from a world that no longer exists.",
			"",
			"Try the action again so it is evaluated against current state.",
		].join("\n");

		deps.state.recordBlocked(action.id, "stale judge decision", checkpointId);
		return { allowed: false, message, decision, checkpoint, plan };
	}

	// --- decide ---
	if (decision.decision === "PASS") {
		deps.state.recordAllowed(action.id, checkpointId);
		log.info("checkpoint passed", { checkpointId, judge: decision.judgeId, confidence: decision.confidence });
		return { allowed: true, decision, checkpoint, plan };
	}

	if (decision.decision === "REVIEW" && deps.confirmWithUser) {
		const approved = await deps.confirmWithUser(
			"Harness: this action needs your review",
			renderBlock({ action, checkpoint, decision, plan, contract, state: deps.state.getState() }),
		);

		deps.state.emit("user_intervention", { checkpointId, decisionId, approved });

		if (approved) {
			deps.state.recordAllowed(action.id, checkpointId);
			log.info("user approved a REVIEW checkpoint", { checkpointId });
			return { allowed: true, decision, checkpoint, plan };
		}

		deps.state.recordBlocked(action.id, "user rejected after review", checkpointId, "user_rejected");
		return {
			allowed: false,
			message: `BLOCKED — you rejected this action after review.\n\nAction: ${action.summary}`,
			decision,
			checkpoint,
			plan,
		};
	}

	const message = args.renderRejection
		? renderCompletionRejection({ decision, plan, contract })
		: renderBlock({ action, checkpoint, decision, plan, contract, state: deps.state.getState() });

	deps.state.recordBlocked(action.id, decision.decision, checkpointId);
	log.info("checkpoint blocked", { checkpointId, verdict: decision.decision, judge: decision.judgeId });

	return {
		allowed: false,
		message,
		decision,
		checkpoint,
		plan,
		// A FAIL means the approach is wrong; retrying it unchanged wastes a turn.
		terminate: decision.decision === "FAIL",
	};
}

function recordCheckpoint(
	deps: HarnessCoreDeps,
	action: ProposedAction,
	checkpoint: CheckpointDecision,
	checkpointId = newCheckpointId(),
	dependencyAnalysis?: CheckpointRecord["dependencyAnalysis"],
): string {
	deps.state.recordCheckpoint({
		id: checkpointId,
		type: checkpoint.checkpointType ?? "unspecified",
		reason: checkpoint.reason,
		actionId: action.id,
		relatedRequirements: checkpoint.relatedRequirements,
		severity: checkpoint.severity,
		at: nowIso(),
		stateVersion: deps.state.getVersion(),
		phase: deps.state.getState().phase,
		actionSemantics: action.actionSemantics,
		signals: checkpoint.signals,
		policyDecision: checkpoint.policyDecision ?? "gate",
		...(dependencyAnalysis ? { dependencyAnalysis } : {}),
	});
	return checkpointId;
}

function recordRuntimeToolEvidence(
	deps: HarnessCoreDeps,
	actionId: string,
	summary: string,
	isError: boolean,
): void {
	// Tool outcomes update canonical action/resource state. They become completion
	// evidence only through an explicit typed verification request collected by the
	// Evidence Collector; filenames and prose are never used as implicit links.
	deps.state.recordToolResult(actionId, summary, isError);
}

function completionConditionMessage(
	status: "UNSATISFIED" | "UNKNOWN",
	conditions: readonly CompletionConditionResult[],
): string {
	const heading = status === "UNSATISFIED" ? "COMPLETION REJECTED — deterministic checks failed." : "COMPLETION REJECTED — evidence is incomplete.";
	return [
		heading,
		"",
		...conditions.flatMap((condition) => [
			`${condition.id} [${condition.status}] ${condition.description}`,
			`  ${condition.reason}`,
		]),
		"",
		"Continue the task and address the conditions above.",
	].join("\n");
}
