import type { CheckpointDecision, ProposedAction } from "../checkpoints/types.ts";
import { describeContractItem, type TaskContract } from "../contract/schema.ts";
import { assessFreshness, currentEvidence, currentFacts } from "../state/freshness.ts";
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
	hypotheses: 6,
	verifiedFacts: 12,
	actionArgumentChars: 1200,
	agentAssessmentChars: 600,
} as const;

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
	const requirements: Array<{ id: string; description: string; priority: "hard" | "soft" }> = [];

	for (const r of contract.requirements) {
		// A completion gate answers to every hard requirement; an action gate answers
		// to the ones the checkpoint linked.
		const applies = relevantIds.has(r.id) || (isCompletion && r.priority === "hard");
		if (applies) requirements.push({ id: r.id, description: r.description, priority: r.priority });
	}

	for (const s of contract.successConditions) {
		// At a completion gate every success condition applies; otherwise only linked ones.
		if (isCompletion || relevantIds.has(s.id)) {
			requirements.push({ id: s.id, description: s.description, priority: s.priority });
		}
	}

	// Nothing was linked and nothing matched: fall back to everything binding. If the
	// contract could not say what this action threatens, assume it threatens anything hard.
	if (requirements.length === 0) {
		for (const r of contract.requirements) {
			if (r.priority === "hard") requirements.push({ id: r.id, description: r.description, priority: r.priority });
		}
	}

	// Only hard constraints. Asking the Judge to adjudicate a stated preference wastes
	// a question and invites it to block on something the user said was negotiable.
	const constraints = contract.constraints
		.filter((c) => c.priority === "hard")
		.map((c) => ({ id: c.id, description: c.description }));

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
	const requirementIds = new Set(requirements.map((r) => r.id));

	/**
	 * Evidence selection: relevant, current and fresh.
	 *
	 * Superseded items are excluded because §22 says the Judge receives current truth,
	 * not the full contradiction history. Stale items are excluded for the same reason —
	 * an observation taken three state versions ago may describe a world that no longer
	 * exists, and "decisions from stale state" is one of the failures this exists to
	 * prevent.
	 */
	const evidence = currentEvidence(state.evidence)
		.filter((e) => e.requirementIds.some((id) => requirementIds.has(id)))
		.filter((e) => assessFreshness(e, { now, currentStateVersion: state.stateVersion }).fresh)
		.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
		.slice(0, LIMITS.evidenceItems)
		.map((e) => ({
			// Keyed by description so the Judge sees what it is about, not an opaque id.
			requirement: e.requirementIds.map((id) => describeContractItem(contract, id)).join("; ") || e.requirementIds.join(","),
			type: e.type,
			source: e.source,
			result: clamp(e.summary, LIMITS.evidenceResultChars),
			observedAt: e.observedAt,
		}));

	// Explicit user statements always travel with the payload; they outrank everything.
	const userInstructions = [
		...contract.requirements.filter((r) => r.source === "user").map((r) => r.description),
		...contract.constraints.filter((c) => c.source === "user").map((c) => c.description),
		...contract.forbiddenConditions.filter((f) => f.source === "user").map((f) => f.description),
		...contract.successConditions.filter((s) => s.source === "user").map((s) => s.description),
	];

	return {
		goal: contract.goal,
		checkpoint: checkpoint.reason,
		proposedAction: action.summary,
		proposedActionArguments: truncateArguments(action.input),
		userInstructions,
		relevantRequirements: requirements.map((r) => r.description),
		hardConstraints: contract.constraints.filter((c) => c.priority === "hard").map((c) => c.description),
		forbiddenConditions: contract.forbiddenConditions.map((f) => f.description),

		verifiedFacts: currentFacts(state.verifiedFacts)
			.slice(-LIMITS.verifiedFacts)
			.map((f) => f.statement),

		evidence,

		// Sent explicitly as hypotheses so the Judge cannot mistake a belief for a fact (§18).
		hypotheses: state.hypotheses
			.filter((h) => h.status === "open" || h.status === "supported")
			.slice(-LIMITS.hypotheses)
			.map((h) => `${h.statement} (unconfirmed, confidence ${h.confidence.toFixed(2)})`),

		recentActions: state.actions
			.slice(-LIMITS.recentActions)
			.map((a) => `${a.summary} → ${a.outcome}${a.resultSummary ? `: ${clamp(a.resultSummary, 120)}` : ""}`),

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
		if (typeof value === "string") {
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
