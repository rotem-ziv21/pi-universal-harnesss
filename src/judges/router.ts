import type { CheckpointSeverity } from "../checkpoints/types.ts";
import type { JudgeConfig, JudgeFailurePolicy } from "../config/schema.ts";
import { errorMessage, HarnessError } from "../util/errors.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import type { AssessQuery, Judge, JudgeDecision, JudgeQuery, JudgeStats } from "./judge.ts";
import { emptyStats } from "./judge.ts";
import { unavailableDecision } from "./normalize.ts";

/**
 * Judge routing and the failure policy (§40, §41).
 *
 * The router owns one question: **what happens when no Judge can answer?**
 *
 * §40 is explicit that critical actions must not be silently allowed, so the MVP
 * default is conservative:
 *
 *   critical    → user_review   (block and ask; fail_closed when there is no UI)
 *   noncritical → fallback      (try the chain, warn if it degrades)
 *
 * `fail_open` exists because the brief lists it, but it is never a default and the
 * router logs loudly every time it is used. A harness configured to fail open on
 * critical checkpoints is a harness that is off.
 *
 * Fallbacks go through the same `Judge` interface, so nothing about the chain leaks
 * into the Jev adapter (§65.15).
 */

export interface JudgeRouterOptions {
	readonly primary?: Judge | undefined;
	/** Tried in order when the primary cannot answer. */
	readonly fallbacks?: readonly Judge[];
	readonly config: JudgeConfig;
	readonly logger?: Logger;
	/**
	 * Ask the user to adjudicate. Absent in print/JSON mode, which is exactly why
	 * `user_review` degrades to `fail_closed` when there is no UI.
	 */
	readonly requestUserReview?: ((decision: UserReviewRequest) => Promise<boolean>) | undefined;
}

export interface UserReviewRequest {
	readonly reason: string;
	readonly proposedAction: string;
	readonly checkpointType: string;
	readonly severity: CheckpointSeverity;
}

export interface RoutedDecision extends JudgeDecision {
	/** True when the primary Judge did not produce this. */
	readonly degraded: boolean;
	/** Judges that failed, with why, for the explainability output. */
	readonly attempts: ReadonlyArray<{ judgeId: string; error: string }>;
}

export interface JudgeRouter {
	evaluate(query: JudgeQuery, severity: CheckpointSeverity): Promise<RoutedDecision>;
	assess(query: AssessQuery): Promise<number>;
	stats(): JudgeStats & { byJudge: Record<string, JudgeStats> };
	/** For `/harness status` and `doctor`. */
	describe(): { primary: string | undefined; fallbacks: string[]; enabled: boolean };
}

export function createJudgeRouter(options: JudgeRouterOptions): JudgeRouter {
	const log = (options.logger ?? nullLogger).child("judge:router");
	const { config } = options;

	const chain = (): Judge[] => {
		const judges: Judge[] = [];
		if (options.primary) judges.push(options.primary);
		for (const fallback of options.fallbacks ?? []) judges.push(fallback);
		return judges;
	};

	return {
		async evaluate(query: JudgeQuery, severity: CheckpointSeverity): Promise<RoutedDecision> {
			if (!config.enabled) {
				return applyPolicy(policyFor(config, severity), query, severity, [], options, log, "The Judge is disabled in configuration.");
			}

			const attempts: Array<{ judgeId: string; error: string }> = [];
			const judges = chain();

			for (let i = 0; i < judges.length; i++) {
				const judge = judges[i]!;

				try {
					if (!(await judge.isAvailable())) {
						attempts.push({ judgeId: judge.id, error: "not available (unconfigured or missing credentials)" });
						continue;
					}

					const decision = await judge.evaluate(query);
					const degraded = i > 0;

					if (degraded) {
						log.warn("decision produced by a fallback Judge", {
							judge: judge.id,
							decision: decision.decision,
							failedPrimaries: attempts.length,
						});
					}

					return { ...decision, degraded, attempts };
				} catch (e) {
					// A user abort is not a Judge failure; it must not trigger the fallback chain.
					if (e instanceof HarnessError && e.code === "ABORTED") throw e;

					const message = errorMessage(e);
					attempts.push({ judgeId: judge.id, error: message });
					log.warn("judge failed, trying next in chain", { judge: judge.id, error: message });
				}
			}

			return applyPolicy(
				policyFor(config, severity),
				query,
				severity,
				attempts,
				options,
				log,
				attempts.length > 0 ? `All judges failed: ${attempts.map((a) => `${a.judgeId} (${a.error})`).join("; ")}` : "No Judge is configured.",
			);
		},

		/**
		 * `assess` is a cheap escalation helper, not a gate. It throws on failure and
		 * lets the caller decide — the Checkpoint Detector already fails toward gating.
		 */
		async assess(query: AssessQuery): Promise<number> {
			if (!config.enabled) throw new HarnessError("JUDGE_NOT_CONFIGURED", "The Judge is disabled in configuration.");

			let lastError: unknown;
			for (const judge of chain()) {
				try {
					if (!(await judge.isAvailable())) continue;
					return await judge.assess(query);
				} catch (e) {
					if (e instanceof HarnessError && e.code === "ABORTED") throw e;
					lastError = e;
				}
			}
			throw lastError instanceof HarnessError
				? lastError
				: new HarnessError("JUDGE_UNREACHABLE", `No Judge could answer: ${errorMessage(lastError)}`);
		},

		stats() {
			const byJudge: Record<string, JudgeStats> = {};
			let total = emptyStats();

			for (const judge of chain()) {
				const s = judge.stats();
				byJudge[judge.id] = s;
				total = {
					calls: total.calls + s.calls,
					retries: total.retries + s.retries,
					failures: total.failures + s.failures,
					totalLatencyMs: total.totalLatencyMs + s.totalLatencyMs,
					inputTokens: total.inputTokens + s.inputTokens,
					outputTokens: total.outputTokens + s.outputTokens,
					...(s.estimatedCostUsd !== undefined
						? { estimatedCostUsd: (total.estimatedCostUsd ?? 0) + s.estimatedCostUsd }
						: {}),
				};
			}
			return { ...total, byJudge };
		},

		describe: () => ({
			primary: options.primary?.id,
			fallbacks: (options.fallbacks ?? []).map((j) => j.id),
			enabled: config.enabled,
		}),
	};
}

function policyFor(config: JudgeConfig, severity: CheckpointSeverity): JudgeFailurePolicy {
	return severity === "critical" ? config.failurePolicy.critical : config.failurePolicy.noncritical;
}

/**
 * Apply the configured policy when the whole chain has failed.
 *
 * Note that `fallback` lands here only when the fallbacks *themselves* failed, so at
 * this point it behaves as `fail_closed` for critical checkpoints and `fail_open` for
 * noncritical ones. That asymmetry is the point: a failed Judge should stop a deploy,
 * not stop a file read.
 */
async function applyPolicy(
	policy: JudgeFailurePolicy,
	query: JudgeQuery,
	severity: CheckpointSeverity,
	attempts: ReadonlyArray<{ judgeId: string; error: string }>,
	options: JudgeRouterOptions,
	log: Logger,
	reason: string,
): Promise<RoutedDecision> {
	const base = { degraded: true, attempts };

	switch (policy) {
		case "fail_closed":
			log.warn("judge unavailable; failing closed", { severity, reason });
			return { ...unavailableDecision({ query, judgeId: "policy:fail_closed", verdict: "FAIL", reason }), ...base };

		case "user_review": {
			if (!options.requestUserReview) {
				// No UI to ask. Falling back to fail_closed is the only safe reading.
				log.warn("judge unavailable and no UI for review; failing closed", { severity, reason });
				return {
					...unavailableDecision({
						query,
						judgeId: "policy:user_review",
						verdict: "FAIL",
						reason: `${reason} No interactive UI is available to request review, so the action is blocked.`,
					}),
					...base,
				};
			}

			const approved = await options.requestUserReview({
				reason,
				proposedAction: query.state.proposedAction,
				checkpointType: query.checkpointType,
				severity,
			});

			log.info("judge unavailable; user adjudicated", { severity, approved });
			return {
				...unavailableDecision({
					query,
					judgeId: "policy:user_review",
					verdict: approved ? "PASS" : "FAIL",
					reason: `${reason} The user ${approved ? "approved" : "rejected"} the action manually.`,
				}),
				...base,
				confidence: approved ? 1 : 1, // A human decision is certain by definition.
			};
		}

		case "fallback":
			if (severity === "critical") {
				log.warn("fallback chain exhausted on a critical checkpoint; failing closed", { reason });
				return {
					...unavailableDecision({
						query,
						judgeId: "policy:fallback",
						verdict: "FAIL",
						reason: `${reason} This is a critical checkpoint, so it cannot be allowed without a decision.`,
					}),
					...base,
				};
			}
			log.warn("fallback chain exhausted on a noncritical checkpoint; allowing with a warning", { reason });
			return {
				...unavailableDecision({
					query,
					judgeId: "policy:fallback",
					verdict: "PASS",
					reason: `${reason} This checkpoint is not critical, so it proceeds unverified.`,
				}),
				...base,
			};

		case "fail_open":
			// Deliberately loud: this configuration disables the harness's core promise.
			log.error("judge unavailable; failing OPEN — the action proceeds unverified", { severity, reason });
			return {
				...unavailableDecision({
					query,
					judgeId: "policy:fail_open",
					verdict: "PASS",
					reason: `${reason} The failure policy is fail_open, so the action proceeds WITHOUT verification.`,
				}),
				...base,
			};
	}
}
