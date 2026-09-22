import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import { describeContractItem, type TaskContract } from "../contract/schema.ts";
import { assessFreshness, changedTargetsSince, currentFacts } from "../state/freshness.ts";
import type { HarnessState } from "../state/types.ts";
import { clamp } from "../util/json.ts";
import type { JudgeQuery, JudgeState } from "./judge.ts";

/**
 * The relevance-selection layer (§37) and the anti-capture rule (§38).
 *
 * Two jobs, both essential.
 *
 * **Keep it small.** The full Pi context is never sent. A 262K window costs money,
 * adds latency, and buries the three facts that matter under thousands of irrelevant
 * tokens. Everything here is selected because it bears on *this* checkpoint.
 *
 * **Keep it honest.** The payload is assembled by the harness from canonical state —
 * actual tool outputs, actual user constraints, actual verified evidence. The worker
 * model cannot write this object. Its opinion may appear only as `agentAssessment`,
 * explicitly labelled untrusted, and every Judge prompt is told to disregard it as a
 * basis for PASS. Without this rule a model could simply assert "everything passed
 * and this is safe" and have the Judge ratify it.
 */

/** Caps, chosen so a payload stays in the low thousands of tokens. */
const LIMITS = {
	evidenceItems: 20,
	evidenceResultChars: 400,
	recentActions: 8,
	runtimeObservations: 12,
	observationChars: 300,
	hypotheses: 6,
	verifiedFacts: 12,
	actionArgumentChars: 1200,
	agentAssessmentChars: 600,
} as const;

const PAYLOAD_ARGUMENTS: Record<string, true> = {
	content: true,
	newText: true,
	oldText: true,
	edits: true,
	data: true,
	body: true,
	patch: true,
	replacement: true,
};

export interface BuildPayloadArgs {
	readonly contract: TaskContract;
	readonly state: HarnessState;
	readonly checkpoint: CheckpointDecision;
	readonly action: ProposedAction;
	/** Untrusted worker opinion, if it offered one. */
	readonly agentAssessment?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}

export function buildJudgeQuery(args: BuildPayloadArgs): JudgeQuery {
	const { contract, state, checkpoint, action } = args;

	const relevantIds = new Set(checkpoint.relatedRequirements);
	const isCompletion = checkpoint.checkpointType === "completion_claim";

	/**
	 * What must this checkpoint prove?
	 *
	 * Both requirements and success conditions are evaluated as "requirements" by the
	 * Judge — the distinction matters to the contract, not to the question being asked,
	 * which is the same either way: *is this sufficiently supported by the evidence?*
	 *
	 * Including success conditions here is load-bearing. A critical action commonly
	 * says `requiresVerificationOf: ["s1"]`, and the Evidence Planner dutifully collects
	 * evidence for `s1`. If the payload only ever carried `contract.requirements`, that
	 * evidence would be filtered straight back out and the Judge would be asked to
	 * approve an irreversible action with nothing in front of it.
	 */
	const requirements: Array<{ id: string; description: string; priority: "hard" | "soft"; verifiable: boolean }> = [];
	const verifiable = (item: { verification?: readonly unknown[] }) => (item.verification?.length ?? 0) > 0;

	for (const r of contract.requirements) {
		// A completion gate answers to every hard requirement; an action gate answers
		// to the ones the checkpoint linked.
		const applies = relevantIds.has(r.id) || (isCompletion && r.priority === "hard");
		if (applies) requirements.push({ id: r.id, description: r.description, priority: r.priority, verifiable: verifiable(r) });
	}

	for (const s of contract.successConditions) {
		// At a completion gate every success condition applies; otherwise only linked ones.
		if (isCompletion || relevantIds.has(s.id)) {
			requirements.push({ id: s.id, description: s.description, priority: s.priority, verifiable: verifiable(s) });
		}
	}

	/**
	 * An action gate with no linked requirement asks only about the action itself:
	 * does it violate a constraint or a user instruction? It deliberately does NOT
	 * fall back to "prove every hard requirement of the task first". That fallback
	 * turned a user-requested `rm *.log` into "show me evidence the comment was added
	 * to app.py", which the worker could never satisfy — and the loop began there.
	 */

	const constraints = [
		...contract.constraints
			.filter((constraint) => constraint.priority === "hard" && (isCompletion || relevantIds.has(constraint.id)))
			.map((constraint) => ({ id: constraint.id, description: constraint.description })),
		...contract.forbiddenConditions
			.filter((condition) => condition.priority === "hard" && (isCompletion || relevantIds.has(condition.id)))
			.map((condition) => ({ id: condition.id, description: condition.description })),
	];

	return {
		state: buildState(args, requirements),
		requirements,
		constraints,
		checkpointType: checkpoint.checkpointType ?? "unspecified",
		stateVersion: state.stateVersion,
		...(args.signal ? { signal: args.signal } : {}),
	};
}

function buildState(
	args: BuildPayloadArgs,
	requirements: ReadonlyArray<{ id: string; description: string }>,
): JudgeState {
	const { contract, state, checkpoint, action } = args;
	const now = Date.now();
	const evidenceBundles = requirements.map((requirement) => {
		const selected: Array<{
			id: string;
			type: string;
			source: string;
			result: string;
			trust: string;
			selectionReason: string;
			observedAt: string;
		}> = [];
		const excluded: Array<{ id: string; reason: string }> = [];
		const ordered = [...state.evidence].sort(
			(a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id),
		);

		for (const item of ordered) {
			if (!item.requirementIds.includes(requirement.id)) {
				excluded.push({ id: item.id, reason: "mapped to a different requirement" });
				continue;
			}
			if (item.supersededBy) {
				excluded.push({ id: item.id, reason: `superseded by ${item.supersededBy}` });
				continue;
			}
			const freshness = assessFreshness(item, {
				now,
				currentStateVersion: state.stateVersion,
				changedTargets: changedTargetsSince(state.actions, item.stateVersion),
			});
			if (!freshness.fresh) {
				excluded.push({ id: item.id, reason: freshness.reason });
				continue;
			}
			if (selected.length >= LIMITS.evidenceItems) {
				excluded.push({ id: item.id, reason: `bundle limit ${LIMITS.evidenceItems} reached` });
				continue;
			}
			selected.push({
				id: item.id,
				type: item.type,
				source: item.source,
				result: clamp(item.summary, LIMITS.evidenceResultChars),
				trust: item.trust,
				selectionReason: `direct requirementIds mapping; ${item.result}; fresh (${freshness.reason})`,
				observedAt: item.observedAt,
			});
		}
		return { requirementId: requirement.id, selected, excluded: excluded.slice(0, LIMITS.evidenceItems) };
	});

	const evidence = evidenceBundles.flatMap((bundle) =>
		bundle.selected.map((item) => ({
			requirement: describeContractItem(contract, bundle.requirementId),
			type: item.type,
			source: item.source,
			result: item.result,
			observedAt: item.observedAt,
		})),
	);

	// Explicit user statements always travel with the payload; they outrank everything.
	const userInstructions = [
		...contract.requirements.filter((r) => r.source === "user").map((r) => r.description),
		...contract.constraints.filter((c) => c.source === "user").map((c) => c.description),
		...contract.forbiddenConditions.filter((f) => f.source === "user").map((f) => f.description),
		...contract.successConditions.filter((s) => s.source === "user").map((s) => s.description),
	];

	return {
		phase: state.phase,
		normalizedAction: {
			actionType: action.actionSemantics.actionType,
			...(action.actionSemantics.target ? { target: action.actionSemantics.target } : {}),
			targetProvenance: action.actionSemantics.targetProvenance,
			targetScope: action.actionSemantics.targetScope,
			mutationType: action.actionSemantics.mutationType,
			reversibility: action.actionSemantics.reversibility,
			externalSideEffect: action.actionSemantics.externalSideEffect,
			capabilities: action.actionSemantics.capabilities,
		},
		goal: contract.goal,
		checkpoint: checkpoint.reason,
		proposedAction: action.summary,
		proposedActionArguments: truncateArguments(action.input),
		userInstructions,
		relevantRequirements: requirements.map((requirement) => requirement.description),
		hardConstraints: contract.constraints
			.filter(
				(constraint) =>
					constraint.priority === "hard" &&
					(checkpoint.checkpointType === "completion_claim" || checkpoint.relatedRequirements.includes(constraint.id)),
			)
			.map((constraint) => constraint.description),
		forbiddenConditions: contract.forbiddenConditions
			.filter(
				(condition) =>
					checkpoint.checkpointType === "completion_claim" || checkpoint.relatedRequirements.includes(condition.id),
			)
			.map((condition) => condition.description),

		verifiedFacts: currentFacts(state.verifiedFacts)
			.slice(-LIMITS.verifiedFacts)
			.map((f) => f.statement),

		evidence,
		evidenceBundles,

		// Sent explicitly as hypotheses so the Judge cannot mistake a belief for a fact (§18).
		hypotheses: state.hypotheses
			.filter((h) => h.status === "open" || h.status === "supported")
			.slice(-LIMITS.hypotheses)
			.map((h) => `${h.statement} (unconfirmed, confidence ${h.confidence.toFixed(2)})`),

		recentActions: state.actions
			.slice(-LIMITS.recentActions)
			.map((a) => `${a.summary} → ${a.outcome}${a.resultSummary ? `: ${clamp(a.resultSummary, 120)}` : ""}`),

		runtimeObservations: state.actions
			.filter((a) => (a.outcome === "succeeded" || a.outcome === "failed") && a.resultSummary)
			.slice(-LIMITS.runtimeObservations)
			.map((a) => ({
				action: clamp(a.summary, 200),
				outcome: a.outcome,
				result: clamp(a.resultSummary ?? "", LIMITS.observationChars),
			})),

		counters: {
			toolCalls: state.counters.toolCalls,
			checkpoints: state.counters.checkpoints,
			blocks: state.counters.blocks,
			completionAttempts: state.counters.completionAttempts,
			turns: state.counters.turns,
		},

		stateVersion: state.stateVersion,

		...(args.agentAssessment
			? {
					agentAssessment: `[UNTRUSTED — this is the working agent's own claim, not evidence] ${clamp(
						args.agentAssessment,
						LIMITS.agentAssessmentChars,
					)}`,
				}
			: {}),
	};
}

/**
 * Tool arguments can be enormous — a whole file body in a `write` call. The Judge
 * needs to know *what* is being written and where, not the full contents.
 */
function truncateArguments(input: Record<string, unknown>): unknown {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (key in PAYLOAD_ARGUMENTS) {
			const size = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
			out[key] = `[payload omitted: ${size} chars]`;
		} else if (typeof value === "string") {
			out[key] = clamp(value, LIMITS.actionArgumentChars);
		} else if (Array.isArray(value)) {
			out[key] = value.length > 10 ? [...value.slice(0, 10), `…${value.length - 10} more items`] : value;
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Rough token estimate for logging, so payload growth is visible in `/harness judge`. */
export function estimatePayloadTokens(query: JudgeQuery): number {
	try {
		return Math.ceil(JSON.stringify(query.state).length / 4);
	} catch {
		return 0;
	}
}
