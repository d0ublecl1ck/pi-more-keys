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
		expect(store.load()).toEqual({ pools: {} });
		expect(store.getPool("any")).toEqual({ failed: {} });
	});

	it("persists state across instances (simulated restart)", () => {
		const store = new StateStore(statePath);
		store.update((data) => {
			data.pools.pool1 = { active: "member-b", failed: { "member-a": { reason: "429", at: 123 } } };
		});
		const reopened = new StateStore(statePath);
		expect(reopened.getPool("pool1")).toEqual({
			active: "member-b",
			failed: { "member-a": { reason: "429", at: 123 } },
		});
	});

	it("writes atomically: valid JSON remains and no tmp files are left behind", () => {
		const store = new StateStore(statePath);
		store.update((data) => {
			data.pools.pool1 = { active: "member-a", failed: {} };
		});
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
			pools: { pool1: { active: "member-a", failed: {} } },
		});
		expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});

	it("recovers from a corrupted file: quarantines it and returns empty state", () => {
		writeFileSync(statePath, "{ not valid json !!!", "utf8");
		const store = new StateStore(statePath);
		expect(store.load()).toEqual({ pools: {} });
		expect(existsSync(statePath)).toBe(false);
		expect(existsSync(`${statePath}.corrupt`)).toBe(true);
		// Subsequent writes work normally after recovery.
		store.update((data) => {
			data.pools.p = { active: "m", failed: {} };
		});
		expect(new StateStore(statePath).getPool("p").active).toBe("m");
	});

	it("keeps valid pools when sibling entries are malformed", () => {
		writeFileSync(
			statePath,
			JSON.stringify({
				pools: {
					good: { active: "m1", failed: { m2: { reason: "500", at: 7 } } },
					bad: "not-an-object",
				},
			}),
			"utf8",
		);
		const store = new StateStore(statePath);
		expect(store.getPool("good")).toEqual({ active: "m1", failed: { m2: { reason: "500", at: 7 } } });
		expect(store.getPool("bad")).toEqual({ failed: {} });
	});
});

describe("sanitizeState", () => {
	it("drops malformed shapes", () => {
		expect(sanitizeState(null)).toEqual({ pools: {} });
		expect(sanitizeState({})).toEqual({ pools: {} });
		expect(sanitizeState({ pools: [] })).toEqual({ pools: {} });
		expect(
			sanitizeState({
				pools: {
					p: { active: 42, failed: { m: { reason: "x" }, n: { reason: "429", at: 1 } } },
				},
			}),
		).toEqual({ pools: { p: { failed: { n: { reason: "429", at: 1 } } } } });
	});
});
