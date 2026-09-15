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
import type { TriggerConfig } from "../src/config.ts";
import { createPoolStreamSimple, type PoolMember, type RouterPool } from "../src/router.ts";
import { StateStore } from "../src/state.ts";

// ---------------------------------------------------------------------------
// Test fixtures. All "keys" here are fake sentinel strings, never real keys.
// ---------------------------------------------------------------------------

const TRIGGER: TriggerConfig = {
	httpStatuses: [401, 429, 500],
	errorKeywords: ["rate limit"],
	caseInsensitive: true,
};

const MEMBER_A: PoolMember = { id: "member-a", apiKey: "test-key-alpha", baseUrl: "https://a.example.com/v1", api: "openai-completions" };
const MEMBER_B: PoolMember = { id: "member-b", apiKey: "test-key-beta", baseUrl: "https://b.example.com/v1", api: "openai-completions" };
const MEMBER_C: PoolMember = { id: "member-c", apiKey: "test-key-gamma", baseUrl: "https://c.example.com/v1", api: "openai-completions" };

function routerModel(): Model<Api> {
	return {
		id: "routed-model",
		name: "Routed Model",
		api: "openai-completions",
		provider: "test-router",
		baseUrl: "https://a.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const CONTEXT: Context = { messages: [] };

function makeMessage(provider: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "routed-model",
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
	apiKey: string | undefined;
	maxRetries: number | undefined;
}

/** Build a dispatch fake that plays one script per call, in order. */
function fakeDispatch(scripts: Script[], calls: DispatchCall[]) {
	return (model: Model<Api>, _context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		calls.push({ provider: model.provider, apiKey: options?.apiKey, maxRetries: options?.maxRetries });
		const script = scripts.length > 1 ? scripts.shift()! : scripts[0]!;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (script.kind !== "aborted" && "status" in script && script.status !== undefined) {
				void options?.onResponse?.({ status: script.status, headers: {} }, model);
			}
			const partial = makeMessage(model.provider);
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
					error: makeMessage(model.provider, { stopReason: "error", errorMessage: script.message }),
				});
			} else if (script.kind === "postContentError") {
				stream.push({ type: "start", partial });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
				stream.push({
					type: "error",
					reason: "error",
					error: makeMessage(model.provider, { stopReason: "error", errorMessage: script.message }),
				});
			} else {
				stream.push({ type: "start", partial });
				stream.push({
					type: "error",
					reason: "aborted",
					error: makeMessage(model.provider, { stopReason: "aborted", errorMessage: "aborted" }),
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

function makePool(overrides?: Partial<RouterPool>): RouterPool {
	return {
		id: "test-router",
		members: [MEMBER_A, MEMBER_B],
		trigger: TRIGGER,
		maxAlternateAttempts: 1,
		...overrides,
	};
}

describe("router: happy path", () => {
	it("serves the request with the active member and forwards the stream", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({ pool: makePool(), state, dispatch: fakeDispatch([{ kind: "success", status: 200 }], calls) });
		const events = collect(stream(routerModel(), CONTEXT, undefined));

		expect((await events).map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ provider: "member-a", apiKey: "test-key-alpha", maxRetries: 0 });
		// No failover happened: state file untouched.
		expect(state.getPool("test-router")).toEqual({ failed: {} });
	});
});

describe("router: failover", () => {
	it("fails over on trigger status before content, persists the switch", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([
				{ kind: "preContentError", status: 429, message: "too many requests" },
				{ kind: "success", status: 200 },
			], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));

		// Only the second attempt's events are visible: exactly one start.
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(calls.map((c) => c.provider)).toEqual(["member-a", "member-b"]);
		expect(calls.map((c) => c.apiKey)).toEqual(["test-key-alpha", "test-key-beta"]);
		expect(calls.every((c) => c.maxRetries === 0)).toBe(true);

		const persisted = state.getPool("test-router");
		expect(persisted.active).toBe("member-b");
		expect(persisted.failed["member-a"]?.reason).toBe("429");
	});

	it("fails over on error keyword match", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([
				{ kind: "preContentError", message: "Rate Limit reached for account" },
				{ kind: "success" },
			], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));
		expect(events.at(-1)?.type).toBe("done");
		expect(calls.map((c) => c.provider)).toEqual(["member-a", "member-b"]);
		expect(state.getPool("test-router").active).toBe("member-b");
		expect(state.getPool("test-router").failed["member-a"]?.reason).toBe('keyword:"rate limit"');
	});

	it("resumes from persisted active member across a simulated restart", async () => {
		const state = new StateStore(statePath);
		state.update((data) => {
			data.pools["test-router"] = { active: "member-b", failed: { "member-a": { reason: "429", at: 1 } } };
		});

		// "Restart": brand-new router instance sharing the same state file.
		const calls: DispatchCall[] = [];
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state: new StateStore(statePath),
			dispatch: fakeDispatch([{ kind: "success" }], calls),
		});
		await collect(stream(routerModel(), CONTEXT, undefined));
		expect(calls.map((c) => c.provider)).toEqual(["member-b"]);

		// A recovering member clears its own stale failure record on success.
		expect(state.getPool("test-router").failed["member-b"]).toBeUndefined();
	});

	it("tries members in config priority order and stops at maxAlternateAttempts", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const pool = makePool({ members: [MEMBER_A, MEMBER_B, MEMBER_C], maxAlternateAttempts: 2 });
		const stream = createPoolStreamSimple({
			pool,
			state,
			dispatch: fakeDispatch([
				{ kind: "preContentError", status: 500, message: "boom-a" },
				{ kind: "preContentError", status: 500, message: "boom-b" },
				{ kind: "success" },
			], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));
		expect(events.at(-1)?.type).toBe("done");
		expect(calls.map((c) => c.provider)).toEqual(["member-a", "member-b", "member-c"]);
		expect(state.getPool("test-router").active).toBe("member-c");
	});

	it("maxAlternateAttempts: 0 means the active member is the only attempt", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool({ maxAlternateAttempts: 0 }),
			state,
			dispatch: fakeDispatch([{ kind: "preContentError", status: 429, message: "nope" }], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));
		expect(events.at(-1)?.type).toBe("error");
		expect(calls).toHaveLength(1);
		// The failure is still recorded even without a retry.
		expect(state.getPool("test-router").failed["member-a"]?.reason).toBe("429");
		expect(state.getPool("test-router").active).toBeUndefined();
	});
});

describe("router: no-retry rules", () => {
	it("never retries after partial output, even on trigger status", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([{ kind: "postContentError", status: 429, message: "mid-stream 429" }], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));

		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(calls).toHaveLength(1);
		expect(state.getPool("test-router").active).toBeUndefined();
		expect(state.getPool("test-router").failed).toEqual({});
	});

	it("does not retry non-trigger errors and does not mark the member failed", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([{ kind: "preContentError", status: 400, message: "context_length_exceeded: too big" }], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));

		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(last && "error" in last ? last.error.errorMessage : "").toContain("context_length_exceeded");
		expect(calls).toHaveLength(1);
		expect(state.getPool("test-router").failed).toEqual({});
	});

	it("does not retry aborted streams", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([{ kind: "aborted" }], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));
		expect(events.at(-1)?.type).toBe("error");
		expect(calls).toHaveLength(1);
		expect(state.getPool("test-router").failed).toEqual({});
	});
});

describe("router: all members fail", () => {
	it("passes the last error through and keeps the active member unchanged", async () => {
		const calls: DispatchCall[] = [];
		const state = new StateStore(statePath);
		const stream = createPoolStreamSimple({
			pool: makePool(),
			state,
			dispatch: fakeDispatch([
				{ kind: "preContentError", status: 429, message: "first failure" },
				{ kind: "preContentError", status: 500, message: "second failure" },
			], calls),
		});
		const events = await collect(stream(routerModel(), CONTEXT, undefined));

		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(last && "error" in last ? last.error.errorMessage : "").toBe("second failure");
		expect(calls.map((c) => c.provider)).toEqual(["member-a", "member-b"]);

		const persisted = state.getPool("test-router");
		expect(persisted.active).toBeUndefined();
		expect(persisted.failed["member-a"]?.reason).toBe("429");
		expect(persisted.failed["member-b"]?.reason).toBe("500");
	});
});

describe("router: model routing", () => {
	it("routes a copy of the model with the member's provider, baseUrl and api", async () => {
		const seen: Array<{ provider: string; baseUrl: string; api: string }> = [];
		const state = new StateStore(statePath);
		const dispatch = (model: Model<Api>): AssistantMessageEventStream => {
			seen.push({ provider: model.provider, baseUrl: model.baseUrl, api: model.api });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = makeMessage(model.provider);
				stream.push({ type: "start", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
				stream.end();
			});
			return stream;
		};
		const pool = makePool({ members: [{ ...MEMBER_B, api: "anthropic-messages" as Api, baseUrl: "https://b.example.com/anthropic" }] });
		const stream = createPoolStreamSimple({ pool, state, dispatch });
		await collect(stream(routerModel(), CONTEXT, undefined));
		expect(seen).toEqual([{ provider: "member-b", baseUrl: "https://b.example.com/anthropic", api: "anthropic-messages" }]);
	});
});
