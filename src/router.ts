/**
 * Failover router: the streamSimple implementation behind every pi-more-keys
 * router provider.
 *
 * Behavior (see BRIEF.md):
 * 1. A request is served by the pool's active member (persisted in state).
 * 2. If the attempt fails with a configured trigger (HTTP status or error
 *    keyword) before any content was produced, the member is marked failed,
 *    state is persisted, and the next member is tried (bounded by
 *    maxAlternateAttempts). On success the active member switches and persists.
 * 3. Once any content event has been forwarded, failover is forbidden —
 *    retrying would duplicate output; the error is passed through as-is.
 * 4. If every allowed attempt fails, the last error is passed through and the
 *    active member stays unchanged.
 *
 * Every attempt runs with maxRetries: 0 so the underlying SDK never retries
 * behind the router's back.
 */

import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { TriggerConfig } from "./config.ts";
import { matchesTrigger } from "./matcher.ts";
import type { StateStore } from "./state.ts";

export interface PoolMember {
	/** Provider id from models.json / auth.json. */
	id: string;
	/** Resolved API key. Held in memory only; never logged or persisted. */
	apiKey: string;
	/** Member endpoint. Falls back to the router model's values when absent. */
	baseUrl?: string;
	api?: Api;
	headers?: Record<string, string>;
}

export interface RouterPool {
	id: string;
	members: PoolMember[];
	trigger: TriggerConfig;
	maxAlternateAttempts: number;
}

export type DispatchFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RouterDeps {
	pool: RouterPool;
	state: StateStore;
	/** Dispatches one attempt to a member. Production: pi-ai compat streamSimple. */
	dispatch: DispatchFn;
	now?: () => number;
}

const CONTENT_EVENT_TYPES = new Set([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

interface AttemptOutcome {
	/** True when the attempt produced a terminal done event. */
	succeeded: boolean;
}

export function createPoolStreamSimple(deps: RouterDeps) {
	const { pool, state, dispatch } = deps;
	const now = deps.now ?? (() => Date.now());

	return function streamPool(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		let lastErrorForwarded = false;

		(async () => {
			const poolState = state.getPool(pool.id);
			const configured = pool.members;
			const activeId =
				poolState.active && configured.some((m) => m.id === poolState.active)
					? poolState.active
					: configured[0]!.id;
			// Active member first, then the remaining members in config priority order.
			const order = [
				...configured.filter((m) => m.id === activeId),
				...configured.filter((m) => m.id !== activeId),
			];
			const maxAttempts = Math.min(order.length, 1 + pool.maxAlternateAttempts);

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const member = order[attempt]!;
				const outcome = await runAttempt(member, attempt === maxAttempts - 1);
				if (outcome.succeeded) {
					if (attempt > 0 || state.getPool(pool.id).failed[member.id]) {
						// Failover succeeded (or a previously failed member recovered):
						// promote the member to active and clear its failure record.
						state.update((data) => {
							const p = (data.pools[pool.id] ??= { failed: {} });
							p.active = member.id;
							delete p.failed[member.id];
						});
					}
					return;
				}
				if (lastErrorForwarded) {
					return;
				}
			}
		})().catch((error) => {
			// Defensive: the router itself must never hang the stream.
			try {
				out.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: `pi-more-keys router failure: ${error instanceof Error ? error.message : String(error)}`,
						timestamp: now(),
					},
				});
			} finally {
				out.end();
			}
		});

		return out;

		async function runAttempt(member: PoolMember, isLastAttempt: boolean): Promise<AttemptOutcome> {
			const memberModel: Model<Api> = {
				...model,
				provider: member.id,
				api: member.api ?? model.api,
				baseUrl: member.baseUrl ?? model.baseUrl,
				...(member.headers ? { headers: { ...model.headers, ...member.headers } } : {}),
			};

			let status: number | undefined;
			const callerOnResponse = options?.onResponse;
			const attemptOptions: SimpleStreamOptions = {
				...options,
				apiKey: member.apiKey,
				maxRetries: 0,
				onResponse: (response, responseModel) => {
					status = response.status;
					return callerOnResponse?.(response, responseModel);
				},
			};

			const inner = dispatch(memberModel, context, attemptOptions);

			// Events are buffered until the first content event. Only then is
			// failover impossible, so the buffer is flushed and the rest of the
			// stream is forwarded live. Before content, an error stays private
			// to the router and may trigger the next member.
			const buffer: AssistantMessageEvent[] = [];
			let live = false;
			let terminal: AssistantMessageEvent | undefined;

			for await (const event of inner) {
				if (live) {
					out.push(event);
				} else {
					buffer.push(event);
					if (CONTENT_EVENT_TYPES.has(event.type)) {
						live = true;
						for (const buffered of buffer) {
							out.push(buffered);
						}
						buffer.length = 0;
					}
				}
				if (event.type === "done" || event.type === "error") {
					terminal = event;
				}
			}

			if (terminal?.type === "done") {
				if (!live) {
					for (const buffered of buffer) {
						out.push(buffered);
					}
				}
				out.end();
				return { succeeded: true };
			}

			const errorEvent = terminal?.type === "error" ? terminal : undefined;
			const errorMessage =
				errorEvent && "error" in errorEvent ? (errorEvent.error.errorMessage ?? "") : "";
			const aborted = options?.signal?.aborted === true || errorEvent?.reason === "aborted";

			if (live || aborted) {
				// Partial output was already forwarded, or the user aborted:
				// pass the terminal event through, never retry.
				if (!live) {
					for (const buffered of buffer) {
						out.push(buffered);
					}
				}
				out.end();
				lastErrorForwarded = true;
				return { succeeded: false };
			}

			const match = matchesTrigger(pool.trigger, { status, errorMessage });
			if (match.matched && match.reason) {
				state.update((data) => {
					const p = (data.pools[pool.id] ??= { failed: {} });
					p.failed[member.id] = { reason: match.reason!, at: now() };
				});
				if (!isLastAttempt) {
					// Discard this attempt's buffered events and try the next member.
					return { succeeded: false };
				}
			}

			// Not a trigger, or no attempts left: forward the original error as-is.
			for (const buffered of buffer) {
				out.push(buffered);
			}
			out.end();
			lastErrorForwarded = true;
			return { succeeded: false };
		}
	};
}
