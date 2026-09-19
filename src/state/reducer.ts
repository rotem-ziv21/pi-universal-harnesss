import type { ContractRevision } from "../contract/revisions.ts";
import type { TaskContract } from "../contract/schema.ts";
import { nowIso } from "../util/ids.ts";
import { applyResourceEffects, createWorkspaceState } from "../resources/registry.ts";
import { contradicts, supersede } from "./freshness.ts";
import type {
	CheckpointRecord,
	CompletionEvaluation,
	Counters,
	EvidenceRef,
	HarnessEvent,
	HarnessState,
	Hypothesis,
	JudgeDecisionRecord,
	RecordedAction,
	TaskPhase,
	VerifiedFact,
} from "./types.ts";

/**
 * The reducer: (state, event) -> state.
 *
 * Pure, total and the only place state changes shape. Because it is pure, the entire
 * canonical state can be rebuilt from the event log alone — which is what makes
 * snapshots a mere optimization and recovery after a crash trivial.
 *
 * `stateVersion` is bumped here and nowhere else (§20).
 */

const emptyCounters = (): Counters => ({
	toolCalls: 0,
	checkpoints: 0,
	blocks: 0,
	judgeCalls: 0,
	judgeFailures: 0,
	completionAttempts: 0,
	contractRevisions: 0,
	turns: 0,
});

export function initialState(taskId: string, contract: TaskContract): HarnessState {
	const at = nowIso();
	return {
		stateVersion: 1,
		taskId,
		phase: "compiling",
		contract,
		contractVersion: contract.version,
		revisions: [],
		workspace: createWorkspaceState(contract.metadata.cwd ?? process.cwd(), {
			allowedScopes: contract.workspace?.allowedScopes,
			protectedResources: contract.workspace?.protectedResources,
		}),
		verifiedFacts: [],
		hypotheses: [],
		evidence: [],
		actions: [],
		checkpoints: [],
		decisions: [],
		counters: emptyCounters(),
		startedAt: at,
		updatedAt: at,
	};
}

/**
 * Events that record something without changing canonical truth do not bump the
 * version. This matters: a `stateVersion` that churns on every log line would make
 * every temporary observation instantly stale and every Judge decision instantly
 * unappliable.
 */
const NON_MUTATING: ReadonlySet<HarnessEvent["type"]> = new Set([
	"tool_proposed",
	"checkpoint_detected",
	"evidence_requested",
	"judge_requested",
	"judge_decision",
	"stale_decision_rejected",
	"judge_unavailable",
	"tool_allowed",
	"tool_blocked",
	"progress_observation",
	"completion_requested",
	"completion_evaluated",
	"completion_rejected",
	"branch_stopped",
]);

export function bumpsVersion(type: HarnessEvent["type"]): boolean {
	return !NON_MUTATING.has(type);
}

export function reduce(state: HarnessState, event: HarnessEvent): HarnessState {
	const next = applyEvent(state, event);
	return {
		...next,
		stateVersion: bumpsVersion(event.type) ? state.stateVersion + 1 : state.stateVersion,
		updatedAt: event.at,
	};
}

function applyEvent(state: HarnessState, event: HarnessEvent): HarnessState {
	const p = event.payload;

	switch (event.type) {
		case "task_created":
			return state;

		case "contract_compiled":
		case "contract_reviewed":
			return state;

		case "contract_locked": {
			const contract = p.contract as TaskContract | undefined;
			return contract ? { ...state, contract, contractVersion: contract.version, phase: "plan" } : state;
		}

		case "contract_revised": {
			const contract = p.contract as TaskContract | undefined;
			const revision = p.revision as ContractRevision | undefined;
			if (!contract) return state;
			return {
				...state,
				contract,
				contractVersion: contract.version,
				revisions: revision ? [...state.revisions, revision] : state.revisions,
				counters: { ...state.counters, contractRevisions: state.counters.contractRevisions + 1 },
			};
		}

		case "phase_changed":
			return { ...state, phase: (p.phase as TaskPhase) ?? state.phase };

		case "tool_proposed": {
			const action = p.action as RecordedAction | undefined;
			if (!action) return state;
			return {
				...state,
				actions: [...state.actions, action],
				counters: { ...state.counters, toolCalls: state.counters.toolCalls + 1 },
			};
		}

		case "checkpoint_detected": {
			const checkpoint = p.checkpoint as CheckpointRecord | undefined;
			if (!checkpoint) return state;
			return {
				...state,
				checkpoints: [...state.checkpoints, checkpoint],
				counters: { ...state.counters, checkpoints: state.counters.checkpoints + 1 },
			};
		}

		case "tool_allowed": {
			const action = state.actions.find((item) => item.id === p.actionId);
			return {
				...state,
				phase: action ? nextPhaseForAction(state.phase, action) : state.phase,
				actions: updateAction(state.actions, p.actionId as string, { outcome: "allowed" }),
				checkpoints: updateCheckpoint(state.checkpoints, p.checkpointId as string | undefined, { outcome: "allowed" }),
			};
		}

		case "tool_blocked":
			return {
				...state,
				actions: updateAction(state.actions, p.actionId as string, { outcome: "blocked" }),
				checkpoints: updateCheckpoint(state.checkpoints, p.checkpointId as string | undefined, {
					outcome: (p.userDecision as CheckpointRecord["outcome"]) ?? "blocked",
				}),
				counters: { ...state.counters, blocks: state.counters.blocks + 1 },
			};

		case "tool_executed":
			return state;

		case "tool_result": {
			const action = state.actions.find((item) => item.id === p.actionId);
			const failed = Boolean(p.isError);
			return {
				...state,
				phase: action && !failed ? nextPhaseForAction(state.phase, action) : state.phase,
				workspace:
					action && !failed
						? applyResourceEffects(state.workspace, action.actionSemantics.effects, action.id, event.at)
						: state.workspace,
				actions: updateAction(state.actions, p.actionId as string, {
					outcome: failed ? "failed" : "succeeded",
					stateVersion: state.stateVersion + 1,
					...(typeof p.summary === "string" ? { resultSummary: p.summary } : {}),
				}),
			};
		}

		case "evidence_added": {
			const added = p.evidence as EvidenceRef | undefined;
			if (!added) return state;
			/**
			 * New evidence that contradicts an older observation supersedes it rather than
			 * overwriting it (§22). History survives; the Judge sees only current truth.
			 */
			const superseded = new Set(state.evidence.filter((e) => contradicts(e, added)).map((e) => e.id));
			const evidence = supersede(state.evidence, superseded, added.id, added.observedAt);
			const phase = state.phase === "completed" || state.phase === "abandoned" ? state.phase : "verify";
			return { ...state, phase, evidence: [...evidence, added] };
		}

		case "evidence_superseded": {
			const ids = new Set((p.evidenceIds as string[] | undefined) ?? []);
			return { ...state, evidence: supersede(state.evidence, ids, (p.bySuccessorId as string) ?? "manual", event.at) };
		}

		case "fact_verified": {
			const fact = p.fact as VerifiedFact | undefined;
			if (!fact) return state;
			const superseded = new Set((p.supersedes as string[] | undefined) ?? []);
			const facts = supersede(state.verifiedFacts, superseded, fact.id, fact.observedAt);
			return { ...state, verifiedFacts: [...facts, fact] };
		}

		case "fact_superseded": {
			const ids = new Set((p.factIds as string[] | undefined) ?? []);
			return { ...state, verifiedFacts: supersede(state.verifiedFacts, ids, (p.bySuccessorId as string) ?? "manual", event.at) };
		}

		case "hypothesis_created": {
			const hypothesis = p.hypothesis as Hypothesis | undefined;
			return hypothesis ? { ...state, hypotheses: [...state.hypotheses, hypothesis] } : state;
		}

		case "hypothesis_updated":
		case "hypothesis_rejected": {
			const id = p.hypothesisId as string | undefined;
			if (!id) return state;
			const patch = (p.patch as Partial<Hypothesis> | undefined) ?? {};
			const status: Hypothesis["status"] | undefined =
				event.type === "hypothesis_rejected" ? "rejected" : (patch.status as Hypothesis["status"] | undefined);
			return {
				...state,
				hypotheses: state.hypotheses.map((h) => (h.id === id ? { ...h, ...patch, ...(status ? { status } : {}) } : h)),
			};
		}

		case "judge_decision": {
			const decision = p.decision as JudgeDecisionRecord | undefined;
			if (!decision) return state;
			return {
				...state,
				decisions: [...state.decisions, decision],
				counters: { ...state.counters, judgeCalls: state.counters.judgeCalls + 1 },
			};
		}

		case "judge_unavailable":
			return { ...state, counters: { ...state.counters, judgeFailures: state.counters.judgeFailures + 1 } };

		case "stale_decision_rejected": {
			const id = p.decisionId as string | undefined;
			return {
				...state,
				decisions: state.decisions.map((d) =>
					d.id === id ? { ...d, applied: false, staleReason: (p.reason as string) ?? "stale" } : d,
				),
			};
		}

		case "branch_stopped":
			return state;

		case "user_intervention":
			return { ...state, phase: (p.phase as TaskPhase) ?? state.phase };

		case "completion_requested":
			return {
				...state,
				phase: "finalize",
				counters: { ...state.counters, completionAttempts: state.counters.completionAttempts + 1 },
			};

		case "completion_rejected":
			return {
				...state,
				phase: "verify",
				...(typeof p.feedback === "string" ? { lastCompletionFeedback: p.feedback } : {}),
			};

		case "completion_evaluated":
			return {
				...state,
				lastCompletionEvaluation: p.evaluation as CompletionEvaluation,
			};

		case "task_completed":
			return { ...state, phase: "completed" };

		case "task_abandoned":
			return { ...state, phase: "abandoned" };

		case "progress_observation":
			return { ...state, counters: { ...state.counters, turns: (p.turns as number) ?? state.counters.turns } };

		case "evidence_requested":
		case "judge_requested":
			return state;
	}
}

/**
 * Rebuild state from the event log. Recovery, and the reason snapshots are optional.
 *
 * Every event is replayed, including `task_created`. It carries no payload changes,
 * but it does bump `stateVersion`, so skipping it would make a replayed state version
 * lag the live one by exactly one — and a version that disagrees with the log would
 * make every restored decision look stale.
 */
export function replay(taskId: string, contract: TaskContract, events: readonly HarnessEvent[]): HarnessState {
	let state = initialState(taskId, contract);
	for (const event of events) {
		state = reduce(state, event);
	}
	return state;
}

function updateAction(actions: readonly RecordedAction[], id: string | undefined, patch: Partial<RecordedAction>): RecordedAction[] {
	if (!id) return [...actions];
	return actions.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

function updateCheckpoint(
	checkpoints: readonly CheckpointRecord[],
	id: string | undefined,
	patch: Partial<CheckpointRecord>,
): CheckpointRecord[] {
	if (!id) return [...checkpoints];
	return checkpoints.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

function nextPhaseForAction(current: TaskPhase, action: RecordedAction): TaskPhase {
	if (current === "completed" || current === "abandoned" || current === "finalize") return current;
	if (current === "compiling" || current === "reviewing" || current === "awaiting_user") return current;
	if (action.actionSemantics.mutationType === "read" || action.actionSemantics.mutationType === "none") {
		return current === "active" || current === "gating" || current === "blocked" || current === "completing" ? "plan" : current;
	}
	return "execute";
}
