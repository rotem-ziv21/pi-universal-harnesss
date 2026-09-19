import { type Static, Type } from "typebox";
import type { ModelAdapter } from "../models/model-adapter.ts";
import { completeStructured } from "../models/structured.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { TaskContract } from "./schema.ts";

/**
 * Contract Review (§14).
 *
 * The Task Compiler is one model call, and one model call can quietly drop
 * "do not touch production" or invent a user requirement that was never stated.
 * An independent pass over (original request, proposed contract) catches both.
 *
 * The verdict is narrow and structured, which is exactly the shape a Judge such as
 * Jev can take over later — `ContractReviewer` is an interface for that reason, and
 * `createModelContractReviewer` is only the MVP implementation.
 */

export const ReviewVerdictSchema = Type.Union([Type.Literal("PASS"), Type.Literal("REVISE"), Type.Literal("NEEDS_USER_INPUT")]);
export type ReviewVerdict = Static<typeof ReviewVerdictSchema>;

export const ReviewFindingSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("missing_user_requirement"),
			Type.Literal("fabricated_user_requirement"),
			Type.Literal("misclassified_priority"),
			Type.Literal("misclassified_source"),
			Type.Literal("contradiction"),
			Type.Literal("unrepresented_ambiguity"),
			Type.Literal("weak_success_conditions"),
			Type.Literal("other"),
		]),
		severity: Type.Union([Type.Literal("high"), Type.Literal("low")]),
		detail: Type.String({ minLength: 1 }),
		/** Contract item id when the finding is about a specific entry. */
		itemId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const ContractReviewSchema = Type.Object(
	{
		verdict: ReviewVerdictSchema,
		findings: Type.Array(ReviewFindingSchema, { default: [] }),
		/** Questions for the user. Only meaningful when the verdict is NEEDS_USER_INPUT. */
		questions: Type.Array(Type.String(), { default: [] }),
	},
	{ additionalProperties: false },
);
export type ContractReview = Static<typeof ContractReviewSchema>;

export interface ContractReviewer {
	readonly id: string;
	review(args: {
		request: string;
		contract: TaskContract;
		signal?: AbortSignal | undefined;
		onAttempt?: ((attempt: number, total: number) => void) | undefined;
	}): Promise<ContractReview>;
}

const SYSTEM_PROMPT = `You audit a proposed Task Contract against the user's original request.

You are not compiling the contract. You are checking someone else's work, and you are the last line of defence before a runtime harness starts enforcing this contract and blocking real actions.

CHECK, IN THIS ORDER OF IMPORTANCE

1. missing_user_requirement (severity: high)
   The user stated something the contract does not capture at all.
   Re-read the request literally. Every prohibition, every "only if", every "make
   sure", every numeric limit must appear somewhere in the contract.

2. fabricated_user_requirement (severity: high)
   An item marked source "user" that the user never actually said. Check the
   "quote" field: if the quote is not really in the request, or it does not
   support the description attached to it, that is a fabrication.
   Derived best practices are fine, but they must be marked source "compiler".

3. misclassified_priority (severity: high when it softens a user statement)
   An explicit user prohibition or requirement marked "soft".
   "Do not touch production" is hard. If it is soft, that is a high finding.

4. misclassified_source (severity: high)
   A compiler inference marked as "user", or vice versa.

5. contradiction (severity: high)
   Two items that cannot both hold.

6. unrepresented_ambiguity (severity: low)
   The request was genuinely unclear and the contract resolved it silently
   instead of recording an ambiguity.

7. weak_success_conditions (severity: low)
   The success conditions could all be true while the user's actual goal remains
   unmet, or they are so vague that no evidence could settle them.

VERDICT
  "PASS"             - no high-severity findings. Low-severity findings are fine
                       to report alongside a PASS.
  "REVISE"           - at least one high-severity finding that the compiler could
                       fix on its own from your findings.
  "NEEDS_USER_INPUT" - the request is genuinely ambiguous in a way that could
                       cause harm, and no re-compilation can resolve it. Put the
                       specific questions in "questions". Use this sparingly.

Do not invent findings to appear useful. An empty findings array with PASS is a
perfectly good and common result. Padding this list makes the harness worse,
because a spurious REVISE burns a model call and can degrade a good contract.`;

export function createModelContractReviewer(adapter: ModelAdapter, options: { logger?: Logger; maxRepairAttempts?: number; timeoutMs?: number } = {}): ContractReviewer {
	const log = (options.logger ?? nullLogger).child("reviewer");

	return {
		id: `model:${adapter.id}`,
		async review({ request, contract, signal, onAttempt }): Promise<ContractReview> {
			const started = Date.now();
			const result = await completeStructured<ContractReview>(adapter, {
				systemPrompt: SYSTEM_PROMPT,
				userPrompt: [
					"<original_request>",
					request,
					"</original_request>",
					"",
					"<proposed_contract>",
					JSON.stringify(stripForReview(contract), null, 2),
					"</proposed_contract>",
					"",
					"Audit the contract against the request and return your verdict.",
				].join("\n"),
				schema: ContractReviewSchema,
				example: {
					verdict: "REVISE",
					findings: [
						{
							kind: "missing_user_requirement",
							severity: "high",
							detail: "The user said 'only push if everything is safe' but no critical action covers publishing.",
						},
					],
					questions: [],
				},
				...(signal ? { signal } : {}),
				...(options.maxRepairAttempts !== undefined ? { maxRepairAttempts: options.maxRepairAttempts } : {}),
				...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
				...(onAttempt ? { onAttempt } : {}),
				logger: log,
			});

			log.info("contract reviewed", {
				model: result.model,
				verdict: result.value.verdict,
				findings: result.value.findings.length,
				high: result.value.findings.filter((f) => f.severity === "high").length,
				ms: Date.now() - started,
			});

			return normalize(result.value);
		},
	};
}

/**
 * A reviewer that always passes.
 *
 * Used when `contractReviewer.enabled` is false, or when no model is available.
 * It is honest about what it is — it does not pretend to have reviewed anything.
 */
export const noopContractReviewer: ContractReviewer = {
	id: "noop",
	async review() {
		return { verdict: "PASS", findings: [], questions: [] };
	},
};

/** Human-readable findings, for the compiler's revision pass and for the UI. */
export function findingLines(review: ContractReview): string[] {
	return review.findings.map((f) => `[${f.severity}] ${f.kind}${f.itemId ? ` (${f.itemId})` : ""}: ${f.detail}`);
}

export function hasHighSeverity(review: ContractReview): boolean {
	return review.findings.some((f) => f.severity === "high");
}

/**
 * Keep the verdict consistent with the findings.
 *
 * Models sometimes list a high-severity problem and then return PASS anyway. The
 * findings are the substance; the verdict is a label. When they disagree, trust the
 * substance and upgrade the verdict.
 */
function normalize(review: ContractReview): ContractReview {
	if (review.verdict === "PASS" && hasHighSeverity(review)) {
		return { ...review, verdict: "REVISE" };
	}
	if (review.verdict === "NEEDS_USER_INPUT" && review.questions.length === 0) {
		// No questions means nothing to ask the user; treat it as a revision request.
		return { ...review, verdict: "REVISE" };
	}
	return review;
}

/** Drop harness bookkeeping the reviewer has no opinion about, to keep the payload tight. */
function stripForReview(contract: TaskContract): unknown {
	const { id: _id, version: _version, metadata: _metadata, ...rest } = contract;
	return rest;
}
