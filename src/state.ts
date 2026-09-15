/**
 * Persisted pool state for pi-more-keys.
 *
 * State file: ~/.pi/agent/pi-more-keys-state.json
 * - Written atomically (tmp file + rename) so a crash never leaves a torn file.
 * - Read through on every load() so commands and concurrent processes stay in sync.
 * - A corrupted file is quarantined to <path>.corrupt and state starts empty.
 *
 * The state file never contains API keys — only provider ids, failure reasons
 * (HTTP status or keyword label) and timestamps.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface FailureRecord {
	/** Why the member failed, e.g. "429" or 'keyword:"rate limit"'. */
	reason: string;
	/** Epoch milliseconds when the failure was recorded. */
	at: number;
}

export interface PoolState {
	/** Currently active member id. Absent means "use members[0] from config". */
	active?: string;
	/** Members that failed recently, keyed by member id. */
	failed: Record<string, FailureRecord>;
}

export interface StateData {
	pools: Record<string, PoolState>;
}

function emptyState(): StateData {
	return { pools: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce unknown parsed JSON into a valid StateData, dropping malformed entries. */
export function sanitizeState(raw: unknown): StateData {
	if (!isRecord(raw) || !isRecord(raw.pools)) {
		return emptyState();
	}
	const pools: Record<string, PoolState> = {};
	for (const [poolId, poolRaw] of Object.entries(raw.pools)) {
		if (!isRecord(poolRaw)) continue;
		const pool: PoolState = { failed: {} };
		if (typeof poolRaw.active === "string" && poolRaw.active.length > 0) {
			pool.active = poolRaw.active;
		}
		if (isRecord(poolRaw.failed)) {
			for (const [memberId, failureRaw] of Object.entries(poolRaw.failed)) {
				if (!isRecord(failureRaw)) continue;
				if (typeof failureRaw.reason !== "string" || typeof failureRaw.at !== "number") continue;
				pool.failed[memberId] = { reason: failureRaw.reason, at: failureRaw.at };
			}
		}
		pools[poolId] = pool;
	}
	return { pools };
}

export class StateStore {
	constructor(private readonly path: string) {}

	/** Current state, read fresh from disk. Corrupted files are quarantined and return empty state. */
	load(): StateData {
		if (!existsSync(this.path)) {
			return emptyState();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			this.quarantineCorruptFile();
			return emptyState();
		}
		return sanitizeState(parsed);
	}

	getPool(poolId: string): PoolState {
		const state = this.load();
		return state.pools[poolId] ?? { failed: {} };
	}

	/** Load, mutate, and atomically persist in one step. */
	update(mutate: (state: StateData) => void): StateData {
		const state = this.load();
		mutate(state);
		this.save(state);
		return state;
	}

	/** Atomic write: serialize to a sibling tmp file, then rename over the target. */
	save(state: StateData): void {
		const tmp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	private quarantineCorruptFile(): void {
		try {
			renameSync(this.path, `${this.path}.corrupt`);
		} catch {
			// Best effort: if quarantine fails, an empty in-memory state is still safe.
		}
	}
}
