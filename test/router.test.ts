import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolFileEntry, TriggerConfig } from "../src/pool-file.ts";
import { createKeyPoolStream } from "../src/router.ts";
import { StateStore } from "../src/state.ts";

// ---------------------------------------------------------------------------
// Test fixtures. All "keys" here are fake sentinel strings, never real keys.
// ---------------------------------------------------------------------------

const PROVIDER_ID = "test-provider";
const ORIGINAL_KEY = "test-key-original";
const EXTRA_KEY_1 = "test-key-extra-1";
const EXTRA_KEY_2 = "test-key-extra-2";

const TRIGGER: TriggerConfig = {
	httpStatuses: [401, 429, 500],
	errorKeywords: ["rate limit"],
	caseInsensitive: true,
};

function makeEntry(extraKeys: string[] = [EXTRA_KEY_1]): PoolFileEntry {
	return { extraKeys, trigger: TRIGGER };
}

function testModel(): Model<Api> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const CONTEXT: Context = { messages: [] };

function makeMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: PROVIDER_ID,
		model: "some-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

type Script =
	| { kind: "success"; status?: number }
	| { kind: "preContentError"; status?: number; message: string }
	| { kind: "postContentError"; status?: number; message: string }
	| { kind: "aborted" };

interface DispatchCall {
	provider: string;
	baseUrl: string;
	api: string;
	apiKey: string | undefined;
	maxRetries: number | undefined;
}

/** Build a dispatch fake that plays one script per call, in order. */
function fakeDispatch(scripts: Script[], calls: DispatchCall[]) {
	return (model: Model<Api>, _context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		calls.push({
			provider: model.provider,
			baseUrl: model.baseUrl,
			api: model.api,
			apiKey: options?.apiKey,
			maxRetries: options?.maxRetries,
		});
		const script = scripts.length > 1 ? scripts.shift()! : scripts[0]!;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (script.kind !== "aborted" && "status" in script && script.status !== undefined) {
				void options?.onResponse?.({ status: script.status, headers: {} }, model);
			}
			const partial = makeMessage();
			if (script.kind === "success") {
				stream.push({ type: "start", partial });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
				stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			} else if (script.kind === "preContentError") {
				stream.push({ type: "start", partial });
				stream.push({
					type: "error",
					reason: "error",
					error: makeMessage({ stopReason: "error", errorMessage: script.message }),
				});
			} else if (script.kind === "postContentError") {
				stream.push({ type: "start", partial });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
				stream.push({
					type: "error",
					reason: "error",
					error: makeMessage({ stopReason: "error", errorMessage: script.message }),
				});
			} else {
				stream.push({ type: "start", partial });
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeMessage({ stopReason: "aborted", errorMessage: "aborted" }),
				});
			}
			stream.end();
		});
		return stream;
	};
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

let dir: string;
let statePath: string;

beforeEach(() => {
	dir = join(tmpdir(), `pi-more-keys-router-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	statePath = join(dir, "state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeRouter(
	scripts: Script[],
	calls: DispatchCall[],
	entry: PoolFileEntry | undefined = makeEntry(),
	state?: StateStore,
) {
	return createKeyPoolStream({
		providerId: PROVIDER_ID,
		getEntry: () => entry,
		state: state ?? new StateStore(statePath),
		dispatch: fakeDispatch(scripts, calls),
	});
}

describe("router: happy path", () => {
	it("serves the request with the original key (index 0) and forwards the stream", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter([{ kind: "success", status: 200 }], calls, makeEntry(), state);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));

		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ apiKey: ORIGINAL_KEY, maxRetries: 0 });
		expect(state.getProvider(PROVIDER_ID)).toEqual({ failed: {} });
	});

	it("keeps provider/baseUrl/api identical across attempts — only the key changes", async () => {
		const calls: DispatchCall[] = [];
		const stream = makeRouter(
			[
				{ kind: "preContentError", status: 429, message: "nope" },
				{ kind: "success" },
			],
			calls,
		);
		await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.provider).toBe(PROVIDER_ID);
			expect(call.baseUrl).toBe("https://api.example.com/v1");
			expect(call.api).toBe("openai-completions");
			expect(call.maxRetries).toBe(0);
		}
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1]);
	});
});

describe("router: failover", () => {
	it("fails over on trigger status before content and persists the switch by index", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[
				{ kind: "preContentError", status: 429, message: "too many requests" },
				{ kind: "success", status: 200 },
			],
			calls,
			makeEntry(),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));

		// Only the second attempt's events are visible: exactly one start.
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1]);

		const persisted = state.getProvider(PROVIDER_ID);
		expect(persisted.active).toBe(1);
		expect(persisted.failed["0"]?.reason).toBe("429");
	});

	it("fails over on error keyword match", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[
				{ kind: "preContentError", message: "Rate Limit reached for account" },
				{ kind: "success" },
			],
			calls,
			makeEntry(),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(events.at(-1)?.type).toBe("done");
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1]);
		expect(state.getProvider(PROVIDER_ID).active).toBe(1);
		expect(state.getProvider(PROVIDER_ID).failed["0"]?.reason).toBe('keyword:"rate limit"');
	});

	it("resumes from the persisted active key across a simulated restart", async () => {
		const state = new StateStore(statePath);
		state.update((data) => {
			data.providers[PROVIDER_ID] = { active: 1, failed: { "0": { reason: "429", at: 1 } } };
		});

		// "Restart": brand-new router sharing the same state file.
		const calls: DispatchCall[] = [];
		const stream = makeRouter([{ kind: "success" }], calls, makeEntry(), new StateStore(statePath));
		await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(calls.map((c) => c.apiKey)).toEqual([EXTRA_KEY_1]);
	});

	it("walks all pooled keys in order until one succeeds", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[
				{ kind: "preContentError", status: 500, message: "boom-0" },
				{ kind: "preContentError", status: 500, message: "boom-1" },
				{ kind: "success" },
			],
			calls,
			makeEntry([EXTRA_KEY_1, EXTRA_KEY_2]),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(events.at(-1)?.type).toBe("done");
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1, EXTRA_KEY_2]);
		expect(state.getProvider(PROVIDER_ID).active).toBe(2);
	});

	it("uses extra keys added mid-session (live pool entry)", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const entry = makeEntry([]);
		const stream = createKeyPoolStream({
			providerId: PROVIDER_ID,
			getEntry: () => entry,
			state,
			dispatch: fakeDispatch([{ kind: "preContentError", status: 429, message: "original fails" }, { kind: "success" }], calls),
		});
		// Key added after the extension started, before this request.
		entry.extraKeys.push(EXTRA_KEY_1);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(events.at(-1)?.type).toBe("done");
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1]);
	});
});

describe("router: no-retry rules", () => {
	it("never retries after partial output, even on trigger status", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[{ kind: "postContentError", status: 429, message: "mid-stream 429" }],
			calls,
			makeEntry(),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));

		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(calls).toHaveLength(1);
		expect(state.getProvider(PROVIDER_ID).active).toBeUndefined();
		expect(state.getProvider(PROVIDER_ID).failed).toEqual({});
	});

	it("does not retry non-trigger errors and does not mark the key failed", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[{ kind: "preContentError", status: 400, message: "context_length_exceeded: too big" }],
			calls,
			makeEntry(),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));

		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(last && "error" in last ? last.error.errorMessage : "").toContain("context_length_exceeded");
		expect(calls).toHaveLength(1);
		expect(state.getProvider(PROVIDER_ID).failed).toEqual({});
	});

	it("does not retry aborted streams", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter([{ kind: "aborted" }], calls, makeEntry(), state);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(events.at(-1)?.type).toBe("error");
		expect(calls).toHaveLength(1);
		expect(state.getProvider(PROVIDER_ID).failed).toEqual({});
	});
});

describe("router: all keys fail", () => {
	it("passes the last error through and keeps the active key unchanged", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = makeRouter(
			[
				{ kind: "preContentError", status: 429, message: "first failure" },
				{ kind: "preContentError", status: 500, message: "second failure" },
			],
			calls,
			makeEntry(),
			state,
		);
		const events = await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));

		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(last && "error" in last ? last.error.errorMessage : "").toBe("second failure");
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY, EXTRA_KEY_1]);

		const persisted = state.getProvider(PROVIDER_ID);
		expect(persisted.active).toBeUndefined();
		expect(persisted.failed["0"]?.reason).toBe("429");
		expect(persisted.failed["1"]?.reason).toBe("500");
	});
});

describe("router: guard rails", () => {
	it("falls back to key index 0 when the persisted active index is stale", async () => {
		const state = new StateStore(statePath);
		state.update((data) => {
			data.providers[PROVIDER_ID] = { active: 7, failed: {} };
		});
		const calls: DispatchCall[] = [];
		const stream = makeRouter([{ kind: "success" }], calls, makeEntry(), state);
		await collect(stream(testModel(), CONTEXT, { apiKey: ORIGINAL_KEY }));
		expect(calls.map((c) => c.apiKey)).toEqual([ORIGINAL_KEY]);
	});

	it("emits an error event instead of hanging when no key is available", async () => {
		const calls: DispatchCall[] = [];
		const stream = makeRouter([], calls, makeEntry([]));
		const events = await collect(stream(testModel(), CONTEXT, {}));
		expect(calls).toHaveLength(0);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(last && "error" in last ? last.error.errorMessage : "").toContain("no key available");
	});
});
