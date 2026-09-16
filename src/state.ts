/**
 * Persisted failover state for pi-more-keys.
 *
 * State file: ~/.pi/agent/pi-more-keys-state.json
 * {
 *   "providers": {
 *     "<provider-id>": {
 *       "active": <key-index>,
 *       "failed": { "<key-index>": { "reason": "429", "at": 0 } }
 *     }
 *   }
 * }
 *
 * Keys are referenced by INDEX (0 = the provider's original key, 1..n =
 * extraKeys from the pool file) so this file never contains any key material.
 * Writes are atomic (tmp + rename); a corrupted file is quarantined to
 * <path>.corrupt and state starts empty.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface FailureRecord {
	/** Why the key failed, e.g. "429" or 'keyword:"rate limit"'. */
	reason: string;
	/** Epoch milliseconds when the failure was recorded. */
	at: number;
}

export interface ProviderState {
	/** Index of the currently active key. Absent means 0 (the original key). */
	active?: number;
	/** Failed key indices, keyed by stringified index. */
	failed: Record<string, FailureRecord>;
}

export interface StateData {
	providers: Record<string, ProviderState>;
}

function emptyState(): StateData {
	return { providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce unknown parsed JSON into a valid StateData, dropping malformed entries. */
export function sanitizeState(raw: unknown): StateData {
	if (!isRecord(raw) || !isRecord(raw.providers)) {
		return emptyState();
	}
	const providers: Record<string, ProviderState> = {};
	for (const [providerId, stateRaw] of Object.entries(raw.providers)) {
		if (!isRecord(stateRaw)) continue;
		const provider: ProviderState = { failed: {} };
		if (
			typeof stateRaw.active === "number" &&
			Number.isInteger(stateRaw.active) &&
			stateRaw.active >= 0
		) {
			provider.active = stateRaw.active;
		}
		if (isRecord(stateRaw.failed)) {
			for (const [index, failureRaw] of Object.entries(stateRaw.failed)) {
				if (!/^\d+$/.test(index)) continue;
				if (!isRecord(failureRaw)) continue;
				if (typeof failureRaw.reason !== "string" || typeof failureRaw.at !== "number") continue;
				provider.failed[index] = { reason: failureRaw.reason, at: failureRaw.at };
			}
		}
		providers[providerId] = provider;
	}
	return { providers };
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

	getProvider(providerId: string): ProviderState {
		const state = this.load();
		return state.providers[providerId] ?? { failed: {} };
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
