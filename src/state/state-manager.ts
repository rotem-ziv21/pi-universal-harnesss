import type { HarnessPaths } from "../config/paths.ts";
import { taskFiles } from "../config/paths.ts";
import type { ContractRevision } from "../contract/revisions.ts";
import { droppedHardUserItems, lock, revise } from "../contract/revisions.ts";
import type { TaskContract } from "../contract/schema.ts";
import { HarnessError } from "../util/errors.ts";
import { newEventId, nowIso } from "../util/ids.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { EventStore } from "./event-store.ts";
import { createEventStore, createMemoryEventStore } from "./event-store.ts";
import { initialState, reduce, replay } from "./reducer.ts";
import type {
	CheckpointRecord,
	CompletionEvaluation,
	EvidenceRef,
	HarnessEvent,
	HarnessEventType,
	HarnessState,
	Hypothesis,
	JudgeDecisionRecord,
	RecordedAction,
	TaskPhase,
	VerifiedFact,
} from "./types.ts";

/**
 * The canonical State Manager (§16).
 *
 * Everything the harness believes lives here. The worker model can read it and reason
 * about it, but every mutation goes through an event, and the only way a model claim
 * becomes state is as a `Hypothesis` — never as a `VerifiedFact`.
 *
 * Invariants enforced here rather than documented and hoped for:
 *  - A verified fact requires runtime evidence. `verifyFact` refuses without it.
 *  - A contract revision may not silently drop a hard user item.
 *  - A Judge decision computed against an old `stateVersion` is not applied (§20).
 */

export interface StateManager {
	readonly taskId: string;
	getState(): HarnessState;
	getVersion(): number;
	getContract(): TaskContract;

	lockContract(contract: TaskContract): void;
	reviseContract(next: TaskContract, options: { reason: string; source: ContractRevision["source"] }): ContractRevision;

	setPhase(phase: TaskPhase, reason?: string): void;

	recordProposedAction(action: RecordedAction): void;
	recordCheckpoint(checkpoint: CheckpointRecord): void;
	recordAllowed(actionId: string, checkpointId?: string): void;
	recordBlocked(actionId: string, reason: string, checkpointId?: string, userDecision?: CheckpointRecord["outcome"]): void;
	recordToolResult(actionId: string, summary: string, isError: boolean): void;

	addEvidence(evidence: EvidenceRef): void;
	verifyFact(fact: Omit<VerifiedFact, "stateVersion">, supersedes?: readonly string[]): VerifiedFact;
	addHypothesis(hypothesis: Omit<Hypothesis, "stateVersion">): Hypothesis;
	updateHypothesis(id: string, patch: Partial<Hypothesis>): void;

	recordJudgeDecision(decision: JudgeDecisionRecord): void;
	rejectStaleDecision(decisionId: string, reason: string): void;
	recordJudgeUnavailable(judgeId: string, reason: string): void;

	requestCompletion(): void;
	recordCompletionEvaluation(evaluation: CompletionEvaluation): void;
	rejectCompletion(feedback: string): void;
	completeTask(): void;
	abandonTask(reason: string): void;

	emit(type: HarnessEventType, payload?: Record<string, unknown>): HarnessEvent;
	readEvents(): HarnessEvent[];
	flush(): void;
	readonly eventStorePath: string;
}

export interface StateManagerOptions {
	readonly paths?: HarnessPaths;
	readonly persist?: boolean;
	readonly snapshotEveryEvents?: number;
	readonly logger?: Logger;
	/**
	 * Resume from a replayed state instead of starting fresh.
	 *
	 * When set, no `task_created` event is emitted — the log already contains one, and
	 * appending a second would corrupt the audit trail on every restart.
	 */
	readonly resumeFrom?: HarnessState;
}

interface Snapshot {
	version: 1;
	state: HarnessState;
	savedAt: string;
}

export function createStateManager(taskId: string, contract: TaskContract, options: StateManagerOptions = {}): StateManager {
	const log = (options.logger ?? nullLogger).child("state");
	const persist = options.persist !== false && Boolean(options.paths);
	const files = options.paths ? taskFiles(options.paths, taskId) : undefined;
	const store: EventStore = persist && files ? createEventStore(files.events, { logger: log }) : createMemoryEventStore();
	const snapshotEvery = options.snapshotEveryEvents ?? 25;

	let state = options.resumeFrom ?? initialState(taskId, contract);
	let sinceSnapshot = 0;

	const snapshot = () => {
		if (!persist || !files) return;
		try {
			const payload: Snapshot = { version: 1, state, savedAt: nowIso() };
			writeJsonAtomic(files.state, payload);
			writeJsonAtomic(files.contract, state.contract);
			sinceSnapshot = 0;
		} catch (e) {
			log.error("snapshot failed", { error: e instanceof Error ? e.message : String(e) });
		}
	};

	const emit = (type: HarnessEventType, payload: Record<string, unknown> = {}): HarnessEvent => {
		// The event carries the version it produces, so the log is self-describing.
		const projected = reduce(state, { id: "", type, at: nowIso(), taskId, stateVersion: state.stateVersion, payload });
		const event: HarnessEvent = {
			id: newEventId(),
			type,
			at: nowIso(),
			taskId,
			stateVersion: projected.stateVersion,
			payload,
		};
		state = projected;
		store.append(event);

		if (++sinceSnapshot >= snapshotEvery) snapshot();
		return event;
	};

	const manager: StateManager = {
		taskId,
		eventStorePath: store.path,

		getState: () => state,
		getVersion: () => state.stateVersion,
		getContract: () => state.contract,

		lockContract(next: TaskContract): void {
			emit("contract_locked", { contract: lock(next), contractVersion: next.version });
			snapshot();
		},

		reviseContract(next: TaskContract, { reason, source }): ContractRevision {
			/**
			 * §46: a hard user constraint cannot be silently removed. If the proposed
			 * revision drops one, the harness refuses — the user must restate the task,
			 * which produces an explicit, auditable change instead of a quiet erosion.
			 */
			const dropped = droppedHardUserItems(state.contract, next);
			if (dropped.length > 0 && source !== "user") {
				throw new HarnessError(
					"CONTRACT_INVALID",
					`Revision would drop hard user requirements without user authorization: ${dropped.join("; ")}`,
					{ details: { dropped, source } },
				);
			}

			const { contract, revision } = revise(state.contract, next, { reason, source });
			emit("contract_revised", { contract, revision });
			snapshot();
			return revision;
		},

		setPhase(phase, reason) {
			if (state.phase === phase) return;
			emit("phase_changed", { phase, previous: state.phase, ...(reason ? { reason } : {}) });
		},

		recordProposedAction: (action) => void emit("tool_proposed", { action }),
		recordCheckpoint: (checkpoint) => void emit("checkpoint_detected", { checkpoint }),

		recordAllowed: (actionId, checkpointId) =>
			void emit("tool_allowed", { actionId, ...(checkpointId ? { checkpointId } : {}) }),

		recordBlocked: (actionId, reason, checkpointId, userDecision) =>
			void emit("tool_blocked", {
				actionId,
				reason,
				...(checkpointId ? { checkpointId } : {}),
				...(userDecision ? { userDecision } : {}),
			}),

		recordToolResult: (actionId, summary, isError) => void emit("tool_result", { actionId, summary, isError }),

		addEvidence: (evidence) => void emit("evidence_added", { evidence }),

		/**
		 * §18: a fact requires runtime evidence. This refuses rather than warns, because a
		 * fabricated "verified fact" is the exact failure the trust separation exists to
		 * prevent — a model asserting "SQL injection confirmed" from an HTTP 500.
		 */
		verifyFact(fact, supersedes): VerifiedFact {
			if (fact.evidenceIds.length === 0) {
				throw new HarnessError("INTERNAL", `Refusing to verify fact "${fact.statement}" with no supporting evidence.`, {
					details: { statement: fact.statement },
				});
			}
			const known = new Set(state.evidence.map((e) => e.id));
			const unknown = fact.evidenceIds.filter((id) => !known.has(id));
			if (unknown.length > 0) {
				throw new HarnessError("INTERNAL", `Fact references unknown evidence: ${unknown.join(", ")}`, { details: { unknown } });
			}

			const materialized: VerifiedFact = { ...fact, stateVersion: state.stateVersion + 1 };
			emit("fact_verified", { fact: materialized, ...(supersedes?.length ? { supersedes } : {}) });
			return materialized;
		},

		addHypothesis(hypothesis): Hypothesis {
			const materialized: Hypothesis = { ...hypothesis, stateVersion: state.stateVersion + 1 };
			emit("hypothesis_created", { hypothesis: materialized });
			return materialized;
		},

		updateHypothesis(id, patch) {
			const type: HarnessEventType = patch.status === "rejected" ? "hypothesis_rejected" : "hypothesis_updated";
			emit(type, { hypothesisId: id, patch });
		},

		recordJudgeDecision: (decision) => void emit("judge_decision", { decision }),

		rejectStaleDecision: (decisionId, reason) => void emit("stale_decision_rejected", { decisionId, reason }),

		recordJudgeUnavailable: (judgeId, reason) => void emit("judge_unavailable", { judgeId, reason }),

		requestCompletion: () => void emit("completion_requested", {}),
		recordCompletionEvaluation: (evaluation) => void emit("completion_evaluated", { evaluation }),
		rejectCompletion: (feedback) => void emit("completion_rejected", { feedback }),

		completeTask() {
			emit("task_completed", {});
			snapshot();
		},

		abandonTask(reason) {
			emit("task_abandoned", { reason });
			snapshot();
		},

		emit,
		readEvents: () => store.readAll(),
		flush: snapshot,
	};

	if (!options.resumeFrom) {
		emit("task_created", { taskId, contractVersion: contract.version, goal: contract.goal });
	}
	return manager;
}

/**
 * Rehydrate a task after a Pi restart (§49).
 *
 * The event log is authoritative. The snapshot is only used to confirm the contract;
 * if the two ever disagree, replay wins, because the log cannot be partially applied
 * whereas a snapshot can be stale.
 */
export function restoreStateManager(
	paths: HarnessPaths,
	taskId: string,
	options: Omit<StateManagerOptions, "paths"> = {},
): { manager: StateManager; state: HarnessState } | undefined {
	const log = (options.logger ?? nullLogger).child("state");
	const files = taskFiles(paths, taskId);

	const contract = readJsonFile<TaskContract>(files.contract) ?? readJsonFile<Snapshot>(files.state)?.state.contract;
	if (!contract) {
		log.warn("cannot restore task: no contract on disk", { taskId });
		return undefined;
	}

	const events = createEventStore(files.events, { logger: log }).readAll();
	if (events.length === 0) {
		log.warn("cannot restore task: empty event log", { taskId });
		return undefined;
	}

	const replayed = replay(taskId, contract, events);
	const manager = createStateManager(taskId, replayed.contract, { paths, ...options, resumeFrom: replayed });

	log.info("task restored", {
		taskId,
		events: events.length,
		stateVersion: replayed.stateVersion,
		phase: replayed.phase,
	});

	return { manager, state: replayed };
}
