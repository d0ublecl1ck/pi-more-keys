import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AddKeyFlowDeps, runAddKeyFlow } from "../src/add-key.ts";
import { KeyPoolStore, loadPoolFile } from "../src/pool-file.ts";

// All "keys" here are fake sentinel strings, never real keys.
const ORIGINAL_KEY = "test-key-original";
const NEW_KEY = "test-key-extra-1";

let dir: string;
let poolPath: string;

beforeEach(() => {
	dir = join(tmpdir(), `pi-more-keys-addkey-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	poolPath = join(dir, "pi-more-keys.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	deps: AddKeyFlowDeps;
	store: KeyPoolStore;
	notifications: Array<{ message: string; type: string }>;
	overrides: Array<{ providerId: string; api: string }>;
}

function makeHarness(overrides?: Partial<AddKeyFlowDeps>): Harness {
	const store = new KeyPoolStore(poolPath, loadPoolFile(poolPath).data);
	const notifications: Harness["notifications"] = [];
	const overridesMade: Harness["overrides"] = [];
	const deps: AddKeyFlowDeps = {
		providerId: "my-provider",
		getCurrentProvider: () => "current-provider",
		getProviderApi: () => "openai-completions",
		isApiDispatchable: () => true,
		isOAuth: () => false,
		getOriginalKey: async () => ORIGINAL_KEY,
		promptKey: async () => NEW_KEY,
		getExtraKeys: (id) => store.getEntry(id)?.extraKeys ?? [],
		addKey: (id, key) => store.addExtraKey(id, key),
		ensureOverride: (providerId, api) => overridesMade.push({ providerId, api }),
		notify: (message, type) => notifications.push({ message, type }),
		...overrides,
	};
	return { deps, store, notifications, overrides: overridesMade };
}

describe("runAddKeyFlow: validation rejections write nothing", () => {
	it("rejects an unknown provider", async () => {
		const h = makeHarness({ getProviderApi: () => undefined });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "unknown-provider" });
		expect(h.notifications.at(-1)?.type).toBe("error");
		expect(h.overrides).toEqual([]);
		expect(h.store.providers).toEqual({});
	});

	it("rejects a provider whose api is not dispatchable", async () => {
		const h = makeHarness({ isApiDispatchable: () => false });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "undispatchable-api" });
		expect(h.notifications.at(-1)?.message).toContain("openai-completions");
		expect(h.overrides).toEqual([]);
		expect(h.store.providers).toEqual({});
	});

	it("rejects an OAuth provider before the original-key lookup", async () => {
		const getOriginalKey = vi.fn(async () => ORIGINAL_KEY);
		const h = makeHarness({ isOAuth: () => true, getOriginalKey });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "oauth-provider" });
		expect(h.notifications.at(-1)?.message).toContain("OAuth");
		expect(h.notifications.at(-1)?.message).toContain("api_key");
		// Never falls through to the misleading "/login" branch.
		expect(getOriginalKey).not.toHaveBeenCalled();
		expect(h.overrides).toEqual([]);
		expect(h.store.providers).toEqual({});
	});

	it("rejects when the original key cannot be resolved", async () => {
		const h = makeHarness({ getOriginalKey: async () => undefined });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "no-original-key" });
		expect(h.notifications.at(-1)?.message).toContain("/login");
		expect(h.overrides).toEqual([]);
		expect(h.store.providers).toEqual({});
	});

	it("rejects empty provider id with no current model selected", async () => {
		const h = makeHarness({ providerId: "  ", getCurrentProvider: () => undefined });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "no-current-provider" });
		expect(h.notifications.at(-1)?.message).toContain("/model");
		expect(h.store.providers).toEqual({});
	});

	it("no argument defaults to the current session model's provider", async () => {
		const h = makeHarness({ providerId: "", getCurrentProvider: () => "current-provider" });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: true, keyCount: 2 });
		expect(h.store.getEntry("current-provider")?.extraKeys).toEqual([NEW_KEY]);
		expect(h.overrides).toEqual([{ providerId: "current-provider", api: "openai-completions" }]);
	});

	it("an explicit argument overrides the current provider", async () => {
		const h = makeHarness({ providerId: "other-provider", getCurrentProvider: () => "current-provider" });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: true, keyCount: 2 });
		expect(h.store.getEntry("other-provider")?.extraKeys).toEqual([NEW_KEY]);
		expect(h.store.getEntry("current-provider")).toBeUndefined();
	});

	it("never prompts for a key when validation fails", async () => {
		const promptKey = vi.fn(async () => NEW_KEY);
		const h = makeHarness({ getProviderApi: () => undefined, promptKey });
		await runAddKeyFlow(h.deps);
		expect(promptKey).not.toHaveBeenCalled();
	});
});

describe("runAddKeyFlow: prompt outcomes", () => {
	it("cancels quietly when no key is entered", async () => {
		const h = makeHarness({ promptKey: async () => undefined });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "cancelled" });
		expect(h.store.providers).toEqual({});
	});

	it("rejects a key identical to the original key", async () => {
		const h = makeHarness({ promptKey: async () => ORIGINAL_KEY });
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: false, reason: "duplicate" });
		expect(h.store.providers).toEqual({});
	});

	it("rejects a key already pooled", async () => {
		const first = makeHarness();
		await runAddKeyFlow(first.deps);
		const second = makeHarness(); // reloads the same pool file
		const result = await runAddKeyFlow(second.deps);
		expect(result).toEqual({ added: false, reason: "duplicate" });
		expect(second.store.getEntry("my-provider")?.extraKeys).toEqual([NEW_KEY]);
	});
});

describe("runAddKeyFlow: success", () => {
	it("persists the key (0600) and activates the override immediately", async () => {
		const h = makeHarness();
		const result = await runAddKeyFlow(h.deps);
		expect(result).toEqual({ added: true, keyCount: 2 });

		// Persisted to the pool file with restrictive permissions.
		expect(statSync(poolPath).mode & 0o777).toBe(0o600);
		const reloaded = loadPoolFile(poolPath);
		expect(reloaded.data.providers["my-provider"]?.extraKeys).toEqual([NEW_KEY]);

		// Override registered for the live session.
		expect(h.overrides).toEqual([{ providerId: "my-provider", api: "openai-completions" }]);

		// Success message mentions the count, never the key itself.
		const last = h.notifications.at(-1);
		expect(last?.type).toBe("info");
		expect(last?.message).toContain("2 keys");
		expect(last?.message).not.toContain(NEW_KEY);
	});

	it("a second extra key raises the count to 3", async () => {
		const first = makeHarness();
		await runAddKeyFlow(first.deps);
		const second = makeHarness({ promptKey: async () => "test-key-extra-2" });
		const result = await runAddKeyFlow(second.deps);
		expect(result).toEqual({ added: true, keyCount: 3 });
		expect(second.store.getEntry("my-provider")?.extraKeys).toEqual([NEW_KEY, "test-key-extra-2"]);
	});

	it("pool file on disk never contains pi-injected material beyond the added key", async () => {
		const h = makeHarness();
		await runAddKeyFlow(h.deps);
		const raw = readFileSync(poolPath, "utf8");
		expect(raw).toContain(NEW_KEY); // the key the user explicitly added
		expect(raw).not.toContain(ORIGINAL_KEY); // the original key stays in auth.json
	});
});
