/**
 * Key pool file for pi-more-keys: ~/.pi/agent/pi-more-keys.json (mode 0600).
 *
 * Shape:
 * {
 *   "providers": {
 *     "<provider-id>": {
 *       "extraKeys": ["...", "..."],
 *       "trigger": { "httpStatuses": [...], "errorKeywords": [...], "caseInsensitive": true }
 *     }
 *   }
 * }
 *
 * This file contains API keys, so it is always written with mode 0600 via an
 * atomic tmp+rename. It is the ONLY file pi-more-keys writes keys to; keys are
 * never logged or copied anywhere else.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const DEFAULT_HTTP_STATUSES = [401, 403, 408, 409, 429, 500, 502, 503, 504];

export interface TriggerConfig {
	httpStatuses: number[];
	errorKeywords: string[];
	caseInsensitive: boolean;
}

export const DEFAULT_TRIGGER: TriggerConfig = {
	httpStatuses: DEFAULT_HTTP_STATUSES,
	errorKeywords: [],
	caseInsensitive: true,
};

export interface PoolFileEntry {
	/** Extra keys appended after the provider's original key (index 0). */
	extraKeys: string[];
	trigger: TriggerConfig;
}

export interface PoolFileData {
	providers: Record<string, PoolFileEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTrigger(raw: unknown, providerId: string, warnings: string[]): TriggerConfig {
	if (raw === undefined) {
		return { ...DEFAULT_TRIGGER, httpStatuses: [...DEFAULT_HTTP_STATUSES] };
	}
	if (!isRecord(raw)) {
		warnings.push(`provider "${providerId}": trigger must be an object, using defaults`);
		return { ...DEFAULT_TRIGGER, httpStatuses: [...DEFAULT_HTTP_STATUSES] };
	}
	const httpStatuses = raw.httpStatuses === undefined ? DEFAULT_HTTP_STATUSES : raw.httpStatuses;
	if (!Array.isArray(httpStatuses) || httpStatuses.some((s) => typeof s !== "number" || !Number.isInteger(s))) {
		warnings.push(`provider "${providerId}": trigger.httpStatuses must be an array of integers, using defaults`);
		return { ...DEFAULT_TRIGGER, httpStatuses: [...DEFAULT_HTTP_STATUSES] };
	}
	const errorKeywords = raw.errorKeywords === undefined ? [] : raw.errorKeywords;
	if (!Array.isArray(errorKeywords) || errorKeywords.some((k) => typeof k !== "string")) {
		warnings.push(`provider "${providerId}": trigger.errorKeywords must be an array of strings, using defaults`);
		return { ...DEFAULT_TRIGGER, httpStatuses: [...DEFAULT_HTTP_STATUSES] };
	}
	const caseInsensitive = raw.caseInsensitive === undefined ? true : raw.caseInsensitive;
	return {
		httpStatuses: httpStatuses as number[],
		errorKeywords: errorKeywords as string[],
		caseInsensitive: typeof caseInsensitive === "boolean" ? caseInsensitive : true,
	};
}

export interface PoolFileLoadResult {
	data: PoolFileData;
	warnings: string[];
}

/** Load the key pool file. A missing file is an empty pool; malformed entries are skipped with warnings. */
export function loadPoolFile(path: string): PoolFileLoadResult {
	const warnings: string[] = [];
	if (!existsSync(path)) {
		return { data: { providers: {} }, warnings };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warnings.push(`failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return { data: { providers: {} }, warnings };
	}
	if (!isRecord(parsed)) {
		warnings.push(`${path}: root must be an object`);
		return { data: { providers: {} }, warnings };
	}
	if ("pools" in parsed) {
		warnings.push(`${path}: the old "pools" config format is no longer supported; use /add-more-key <provider> instead`);
	}
	const rawProviders = isRecord(parsed.providers) ? parsed.providers : {};
	const providers: Record<string, PoolFileEntry> = {};
	for (const [providerId, entryRaw] of Object.entries(rawProviders)) {
		if (!isRecord(entryRaw)) {
			warnings.push(`provider "${providerId}": entry must be an object, skipped`);
			continue;
		}
		const extraKeys = entryRaw.extraKeys === undefined ? [] : entryRaw.extraKeys;
		if (!Array.isArray(extraKeys) || extraKeys.some((k) => typeof k !== "string" || k.length === 0)) {
			warnings.push(`provider "${providerId}": extraKeys must be an array of non-empty strings, skipped`);
			continue;
		}
		providers[providerId] = {
			extraKeys: extraKeys as string[],
			trigger: validateTrigger(entryRaw.trigger, providerId, warnings),
		};
	}
	return { data: { providers }, warnings };
}

/** In-memory pool data + atomic 0600 persistence. */
export class KeyPoolStore {
	constructor(
		private readonly path: string,
		private readonly data: PoolFileData,
	) {}

	get providers(): Record<string, PoolFileEntry> {
		return this.data.providers;
	}

	getEntry(providerId: string): PoolFileEntry | undefined {
		return this.data.providers[providerId];
	}

	/** Append an extra key for a provider and persist. Returns false when the key is already pooled. */
	addExtraKey(providerId: string, key: string): boolean {
		const entry = (this.data.providers[providerId] ??= {
			extraKeys: [],
			trigger: { ...DEFAULT_TRIGGER, httpStatuses: [...DEFAULT_HTTP_STATUSES] },
		});
		if (entry.extraKeys.includes(key)) {
			return false;
		}
		entry.extraKeys.push(key);
		this.save();
		return true;
	}

	/** Atomic write: tmp file (0600) + rename, then enforce 0600 on the target. */
	private save(): void {
		const tmp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// Best effort on filesystems without chmod.
		}
	}
}
