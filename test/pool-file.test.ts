import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_STATUSES, KeyPoolStore, loadPoolFile } from "../src/pool-file.ts";

let dir: string;
let poolPath: string;

beforeEach(() => {
	dir = join(tmpdir(), `pi-more-keys-pool-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	poolPath = join(dir, "pi-more-keys.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadPoolFile", () => {
	it("returns an empty pool when the file is missing", () => {
		const { data, warnings } = loadPoolFile(poolPath);
		expect(data).toEqual({ providers: {} });
		expect(warnings).toEqual([]);
	});

	it("loads entries and applies trigger defaults", () => {
		writeFileSync(
			poolPath,
			JSON.stringify({ providers: { prov1: { extraKeys: ["fake-extra-key-1"] } } }),
			"utf8",
		);
		const { data, warnings } = loadPoolFile(poolPath);
		expect(warnings).toEqual([]);
		expect(data.providers.prov1?.extraKeys).toEqual(["fake-extra-key-1"]);
		expect(data.providers.prov1?.trigger).toEqual({
			httpStatuses: DEFAULT_HTTP_STATUSES,
			errorKeywords: [],
			caseInsensitive: true,
		});
	});

	it("keeps a custom trigger", () => {
		writeFileSync(
			poolPath,
			JSON.stringify({
				providers: {
					prov1: {
						extraKeys: ["fake-extra-key-1"],
						trigger: { httpStatuses: [429], errorKeywords: ["quota"], caseInsensitive: false },
					},
				},
			}),
			"utf8",
		);
		const { data } = loadPoolFile(poolPath);
		expect(data.providers.prov1?.trigger).toEqual({
			httpStatuses: [429],
			errorKeywords: ["quota"],
			caseInsensitive: false,
		});
	});

	it("warns and returns empty on invalid JSON", () => {
		writeFileSync(poolPath, "{ broken", "utf8");
		const { data, warnings } = loadPoolFile(poolPath);
		expect(data.providers).toEqual({});
		expect(warnings.length).toBe(1);
	});

	it("warns about the retired pools config format", () => {
		writeFileSync(poolPath, JSON.stringify({ version: 1, pools: {} }), "utf8");
		const { data, warnings } = loadPoolFile(poolPath);
		expect(data.providers).toEqual({});
		expect(warnings.some((w) => w.includes("no longer supported"))).toBe(true);
	});

	it("skips malformed entries with warnings", () => {
		writeFileSync(
			poolPath,
			JSON.stringify({
				providers: {
					good: { extraKeys: ["fake-extra-key-1"] },
					"not-object": 42,
					"bad-keys": { extraKeys: ["ok", 7] },
				},
			}),
			"utf8",
		);
		const { data, warnings } = loadPoolFile(poolPath);
		expect(Object.keys(data.providers)).toEqual(["good"]);
		expect(warnings.length).toBe(2);
	});
});

describe("KeyPoolStore", () => {
	it("appends extra keys and persists them", () => {
		const store = new KeyPoolStore(poolPath, { providers: {} });
		expect(store.addExtraKey("prov1", "fake-extra-key-1")).toBe(true);
		expect(store.addExtraKey("prov1", "fake-extra-key-2")).toBe(true);

		const reloaded = loadPoolFile(poolPath);
		expect(reloaded.data.providers.prov1?.extraKeys).toEqual(["fake-extra-key-1", "fake-extra-key-2"]);
		expect(reloaded.data.providers.prov1?.trigger.httpStatuses).toEqual(DEFAULT_HTTP_STATUSES);
	});

	it("rejects duplicate keys without writing", () => {
		const store = new KeyPoolStore(poolPath, { providers: {} });
		expect(store.addExtraKey("prov1", "fake-extra-key-1")).toBe(true);
		const before = readFileSync(poolPath, "utf8");
		expect(store.addExtraKey("prov1", "fake-extra-key-1")).toBe(false);
		expect(readFileSync(poolPath, "utf8")).toBe(before);
	});

	it("writes the pool file with mode 0600", () => {
		const store = new KeyPoolStore(poolPath, { providers: {} });
		store.addExtraKey("prov1", "fake-extra-key-1");
		expect(statSync(poolPath).mode & 0o777).toBe(0o600);
	});

	it("writes atomically (no tmp leftovers)", () => {
		const store = new KeyPoolStore(poolPath, { providers: {} });
		store.addExtraKey("prov1", "fake-extra-key-1");
		expect(existsSync(poolPath)).toBe(true);
		expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});
});
