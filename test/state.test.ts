import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, sanitizeState } from "../src/state.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
	dir = join(tmpdir(), `pi-more-keys-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	statePath = join(dir, "state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
	it("returns empty state when the file does not exist", () => {
		const store = new StateStore(statePath);
		expect(store.load()).toEqual({ providers: {} });
		expect(store.getProvider("any")).toEqual({ failed: {} });
	});

	it("persists active key index and failure records across instances (simulated restart)", () => {
		const store = new StateStore(statePath);
		store.update((data) => {
			data.providers.prov1 = { active: 1, failed: { "0": { reason: "429", at: 123 } } };
		});
		const reopened = new StateStore(statePath);
		expect(reopened.getProvider("prov1")).toEqual({
			active: 1,
			failed: { "0": { reason: "429", at: 123 } },
		});
	});

	it("writes atomically: valid JSON remains and no tmp files are left behind", () => {
		const store = new StateStore(statePath);
		store.update((data) => {
			data.providers.prov1 = { active: 0, failed: {} };
		});
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
			providers: { prov1: { active: 0, failed: {} } },
		});
		expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});

	it("recovers from a corrupted file: quarantines it and returns empty state", () => {
		writeFileSync(statePath, "{ not valid json !!!", "utf8");
		const store = new StateStore(statePath);
		expect(store.load()).toEqual({ providers: {} });
		expect(existsSync(statePath)).toBe(false);
		expect(existsSync(`${statePath}.corrupt`)).toBe(true);
		store.update((data) => {
			data.providers.p = { active: 2, failed: {} };
		});
		expect(new StateStore(statePath).getProvider("p").active).toBe(2);
	});

	it("keeps valid providers when sibling entries are malformed", () => {
		writeFileSync(
			statePath,
			JSON.stringify({
				providers: {
					good: { active: 1, failed: { "0": { reason: "500", at: 7 } } },
					bad: "not-an-object",
				},
			}),
			"utf8",
		);
		const store = new StateStore(statePath);
		expect(store.getProvider("good")).toEqual({ active: 1, failed: { "0": { reason: "500", at: 7 } } });
		expect(store.getProvider("bad")).toEqual({ failed: {} });
	});
});

describe("sanitizeState", () => {
	it("drops malformed shapes", () => {
		expect(sanitizeState(null)).toEqual({ providers: {} });
		expect(sanitizeState({})).toEqual({ providers: {} });
		expect(sanitizeState({ providers: [] })).toEqual({ providers: {} });
		// Legacy pool-format state is dropped entirely.
		expect(sanitizeState({ pools: { p: { active: "m", failed: {} } } })).toEqual({ providers: {} });
	});

	it("drops invalid active values and failure records, keeps valid ones", () => {
		expect(
			sanitizeState({
				providers: {
					p: {
						active: -1,
						failed: {
							"0": { reason: "429", at: 1 },
							"x": { reason: "500", at: 2 },
							"1": { reason: "oops" },
						},
					},
					q: { active: 1.5, failed: {} },
				},
			}),
		).toEqual({
			providers: {
				p: { failed: { "0": { reason: "429", at: 1 } } },
				q: { failed: {} },
			},
		});
	});

	it("never stores key material: state only holds indices and metadata", () => {
		const store = new StateStore(statePath);
		store.update((data) => {
			data.providers.p = { active: 1, failed: { "0": { reason: "429", at: 1 } } };
		});
		const raw = readFileSync(statePath, "utf8");
		expect(raw).not.toContain("test-key");
		expect(raw).not.toContain("apiKey");
	});
});
