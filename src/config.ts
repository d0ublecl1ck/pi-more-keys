/**
 * Pool configuration loading and validation for pi-more-keys.
 *
 * Config file: ~/.pi/agent/pi-more-keys.json (non-sensitive).
 */

import { readFileSync } from "node:fs";

export const DEFAULT_HTTP_STATUSES = [401, 403, 408, 409, 429, 500, 502, 503, 504];

export interface TriggerConfig {
	httpStatuses: number[];
	errorKeywords: string[];
	caseInsensitive: boolean;
}

export interface PoolConfig {
	/** Member provider ids from models.json, in priority order. */
	members: string[];
	trigger: TriggerConfig;
	/** Max number of alternate members tried after the active one fails. */
	maxAlternateAttempts: number;
	switchBack: { mode: string };
}

export interface MoreKeysConfig {
	version: number;
	pools: Record<string, PoolConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTrigger(raw: unknown, poolId: string): TriggerConfig {
	const t = isRecord(raw) ? raw : {};
	const httpStatuses = t.httpStatuses === undefined ? DEFAULT_HTTP_STATUSES : t.httpStatuses;
	if (!Array.isArray(httpStatuses) || httpStatuses.some((s) => typeof s !== "number" || !Number.isInteger(s))) {
		throw new Error(`pool "${poolId}": trigger.httpStatuses must be an array of integers`);
	}
	const errorKeywords = t.errorKeywords === undefined ? [] : t.errorKeywords;
	if (!Array.isArray(errorKeywords) || errorKeywords.some((k) => typeof k !== "string")) {
		throw new Error(`pool "${poolId}": trigger.errorKeywords must be an array of strings`);
	}
	const caseInsensitive = t.caseInsensitive === undefined ? true : t.caseInsensitive;
	if (typeof caseInsensitive !== "boolean") {
		throw new Error(`pool "${poolId}": trigger.caseInsensitive must be a boolean`);
	}
	return {
		httpStatuses: httpStatuses as number[],
		errorKeywords: errorKeywords as string[],
		caseInsensitive,
	};
}

function validatePool(raw: unknown, poolId: string): PoolConfig {
	if (!isRecord(raw)) {
		throw new Error(`pool "${poolId}": must be an object`);
	}
	if (!Array.isArray(raw.members) || raw.members.length === 0 || raw.members.some((m) => typeof m !== "string" || m.length === 0)) {
		throw new Error(`pool "${poolId}": members must be a non-empty array of provider id strings`);
	}
	const members = raw.members as string[];
	if (new Set(members).size !== members.length) {
		throw new Error(`pool "${poolId}": members must not contain duplicates`);
	}
	const maxAlternateAttempts = raw.maxAlternateAttempts === undefined ? 1 : raw.maxAlternateAttempts;
	if (typeof maxAlternateAttempts !== "number" || !Number.isInteger(maxAlternateAttempts) || maxAlternateAttempts < 0) {
		throw new Error(`pool "${poolId}": maxAlternateAttempts must be a non-negative integer`);
	}
	const switchBack = isRecord(raw.switchBack) ? raw.switchBack : {};
	const mode = switchBack.mode === undefined ? "manual" : switchBack.mode;
	if (mode !== "manual") {
		throw new Error(`pool "${poolId}": switchBack.mode only supports "manual" (got ${JSON.stringify(mode)})`);
	}
	return {
		members,
		trigger: validateTrigger(raw.trigger, poolId),
		maxAlternateAttempts,
		switchBack: { mode },
	};
}

/** Validate a parsed JSON value as MoreKeysConfig. Throws Error on invalid shape. */
export function validateConfig(raw: unknown): MoreKeysConfig {
	if (!isRecord(raw)) {
		throw new Error("config root must be an object");
	}
	if (raw.version !== 1) {
		throw new Error(`config version must be 1 (got ${JSON.stringify(raw.version)})`);
	}
	if (!isRecord(raw.pools)) {
		throw new Error("config.pools must be an object");
	}
	const pools: Record<string, PoolConfig> = {};
	for (const [poolId, poolRaw] of Object.entries(raw.pools)) {
		pools[poolId] = validatePool(poolRaw, poolId);
	}
	return { version: 1, pools };
}

/** Load and validate the config file. Throws on missing file, invalid JSON, or invalid shape. */
export function loadConfig(path: string): MoreKeysConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`failed to read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return validateConfig(parsed);
	} catch (error) {
		throw new Error(`invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
