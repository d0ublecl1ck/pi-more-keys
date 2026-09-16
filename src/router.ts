/**
 * Failover router: the streamSimple override behind every pooled provider.
 *
 * The key list for a request is `[options.apiKey, ...entry.extraKeys]`:
 * index 0 is the provider's original key as resolved and injected by pi,
 * followed by the extra keys from the pool file. Same provider, same
 * endpoint — only the apiKey changes between attempts.
 *
 * Behavior:
 * 1. A request is served by the active key (persisted in state by index).
 * 2. If the attempt fails with a configured trigger (HTTP status or error
 *    keyword) before any content was produced, the key index is marked failed,
 *    state is persisted, and the next key is tried (each key at most once per
 *    request). On success the active key switches and persists.
 * 3. Once any content event has been forwarded, failover is forbidden —
 *    retrying would duplicate output; the error is passed through as-is.
 * 4. If every key fails, the last error is passed through and the active key
 *    stays unchanged.
 *
 * Every attempt runs with maxRetries: 0 so the underlying SDK never retries
 * behind the router's back. Keys are held in memory only; state records key
 * INDICES, never key material.
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
import { matchesTrigger } from "./matcher.ts";
import type { PoolFileEntry } from "./pool-file.ts";
import type { StateStore } from "./state.ts";

export type DispatchFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RouterDeps {
	providerId: string;
	/** Live read of the pool entry so keys added mid-session take effect immediately. */
	getEntry: () => PoolFileEntry | undefined;
	state: StateStore;
	/** Dispatches one attempt. Production: pi-ai compat streamSimple. */
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
	succeeded: boolean;
}

export function createKeyPoolStream(deps: RouterDeps) {
	const { providerId, state, dispatch } = deps;
	const now = deps.now ?? (() => Date.now());

	return function streamWithKeyPool(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		let terminalForwarded = false;

		(async () => {
			const entry = deps.getEntry();
			const originalKey = options?.apiKey;
			const keys: string[] = [
				...(typeof originalKey === "string" && originalKey.length > 0 ? [originalKey] : []),
				...(entry?.extraKeys ?? []),
			];
			const trigger = entry?.trigger ?? {
				httpStatuses: [401, 403, 408, 409, 429, 500, 502, 503, 504],
				errorKeywords: [],
				caseInsensitive: true,
			};

			if (keys.length === 0) {
				throw new Error(`pi-more-keys: no key available for provider "${providerId}"`);
			}

			const providerState = state.getProvider(providerId);
			const activeIndex =
				providerState.active !== undefined && providerState.active < keys.length
					? providerState.active
					: 0;
			// Active key first, then the remaining keys in pool order.
			const order = [activeIndex, ...keys.map((_, i) => i).filter((i) => i !== activeIndex)];

			for (let attempt = 0; attempt < order.length; attempt++) {
				const keyIndex = order[attempt]!;
				const outcome = await runAttempt(keys[keyIndex]!, keyIndex, trigger, attempt === order.length - 1);
				if (outcome.succeeded) {
					const stale = state.getProvider(providerId).failed[String(keyIndex)];
					if (keyIndex !== activeIndex || stale) {
						// Failover succeeded (or a previously failed key recovered):
						// promote the key to active and clear its failure record.
						state.update((data) => {
							const p = (data.providers[providerId] ??= { failed: {} });
							p.active = keyIndex;
							delete p.failed[String(keyIndex)];
						});
					}
					return;
				}
				if (terminalForwarded) {
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

		async function runAttempt(
			key: string,
			keyIndex: number,
			trigger: PoolFileEntry["trigger"],
			isLastAttempt: boolean,
		): Promise<AttemptOutcome> {
			const callerOnResponse = options?.onResponse;
			let status: number | undefined;
			const attemptOptions: SimpleStreamOptions = {
				...options,
				apiKey: key,
				maxRetries: 0,
				onResponse: (response, responseModel) => {
					status = response.status;
					return callerOnResponse?.(response, responseModel);
				},
			};

			// Same provider, same endpoint: only the key changes between attempts.
			const inner = dispatch(model, context, attemptOptions);

			// Events are buffered until the first content event. Only then is
			// failover impossible, so the buffer is flushed and the rest of the
			// stream is forwarded live. Before content, an error stays private
			// to the router and may trigger the next key.
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
				terminalForwarded = true;
				return { succeeded: false };
			}

			const match = matchesTrigger(trigger, { status, errorMessage });
			if (match.matched && match.reason) {
				state.update((data) => {
					const p = (data.providers[providerId] ??= { failed: {} });
					p.failed[String(keyIndex)] = { reason: match.reason!, at: now() };
				});
				if (!isLastAttempt) {
					// Discard this attempt's buffered events and try the next key.
					return { succeeded: false };
				}
			}

			// Not a trigger, or no keys left: forward the original error as-is.
			for (const buffered of buffer) {
				out.push(buffered);
			}
			out.end();
			terminalForwarded = true;
			return { succeeded: false };
		}
	};
}
