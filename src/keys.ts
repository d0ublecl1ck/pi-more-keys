/**
 * Member API key resolution for pi-more-keys.
 *
 * Keys are read from ~/.pi/agent/auth.json (entries written by `pi /login`,
 * shape: { "<provider>": { "type": "api_key", "key": "..." } }) or, as a
 * fallback, from the member provider's `apiKey` field in models.json using
 * pi's config value syntax (literal, $ENV_VAR, ${ENV_VAR}, !command,
 * $$ / $! escapes).
 *
 * Keys live only in process memory. Nothing in this project logs, prints, or
 * persists them.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface KeyResolutionContext {
	/** Path to auth.json. */
	authPath: string;
	/** The member provider's models.json entry, if any (used for apiKey fallback). */
	providerApiKey?: string;
	/** Environment for $VAR interpolation. Defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Command runner for !command values. Defaults to execSync. */
	exec?: (command: string) => string;
}

interface AuthEntry {
	type?: string;
	key?: string;
}

/** Read auth.json and return the api_key for a provider, or undefined. */
export function readAuthKey(authPath: string, providerId: string): string | undefined {
	if (!existsSync(authPath)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const entry = (parsed as Record<string, AuthEntry>)[providerId];
	if (entry && entry.type === "api_key" && typeof entry.key === "string" && entry.key.length > 0) {
		return entry.key;
	}
	return undefined;
}

/**
 * Resolve a pi config value: literal, $ENV_VAR / ${ENV_VAR} interpolation,
 * !command execution, $$ and $! escapes. Returns undefined when a referenced
 * environment variable is missing or a command fails.
 */
export function resolveConfigValue(
	value: string,
	env: Record<string, string | undefined> = process.env,
	exec: (command: string) => string = (command) => execSync(command, { encoding: "utf8" }).trim(),
): string | undefined {
	if (value.startsWith("!")) {
		try {
			return exec(value.slice(1));
		} catch {
			return undefined;
		}
	}
	let out = "";
	let i = 0;
	while (i < value.length) {
		const ch = value[i];
		if (ch !== "$") {
			out += ch;
			i += 1;
			continue;
		}
		const next = value[i + 1];
		if (next === "$" || next === "!") {
			out += next;
			i += 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", i + 2);
			if (end < 0) {
				out += "$";
				i += 1;
				continue;
			}
			const name = value.slice(i + 2, end);
			const resolved = env[name];
			if (resolved === undefined) {
				return undefined;
			}
			out += resolved;
			i = end + 1;
			continue;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1));
		if (match) {
			const resolved = env[match[0]];
			if (resolved === undefined) {
				return undefined;
			}
			out += resolved;
			i += 1 + match[0].length;
			continue;
		}
		out += "$";
		i += 1;
	}
	return out;
}

/**
 * Resolve the API key for a pool member. Priority:
 * 1. auth.json entry with type "api_key"
 * 2. provider apiKey from models.json, resolved through pi's config value syntax
 */
export function resolveMemberKey(memberId: string, ctx: KeyResolutionContext): string | undefined {
	const fromAuth = readAuthKey(ctx.authPath, memberId);
	if (fromAuth !== undefined) {
		return fromAuth;
	}
	if (ctx.providerApiKey) {
		return resolveConfigValue(ctx.providerApiKey, ctx.env ?? process.env, ctx.exec);
	}
	return undefined;
}

/**
 * Escape a literal key so it survives pi's config value resolution unchanged
 * when passed as ProviderConfig.apiKey (which interpolates $VAR / !command).
 */
export function escapeConfigValueLiteral(literal: string): string {
	return literal.replace(/\$/g, () => "$$").replace(/!/g, () => "$!");
}
