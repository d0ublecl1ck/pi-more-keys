/**
 * pi-more-keys — generic multi-key failover for any api_key provider in pi.
 *
 * Reads ~/.pi/agent/pi-more-keys.json, and for each configured pool registers
 * a router provider whose model list is copied from the pool's first member.
 * Requests to the router provider are served by the active member's key;
 * trigger failures (HTTP status / error keyword) fail over to the next member
 * and the switch is persisted to ~/.pi/agent/pi-more-keys-state.json.
 *
 * Commands:
 *   /more-keys                    show pools, active member, failure records
 *   /more-keys-use <pool> <member>  switch the active member manually
 *   /more-keys-reset <pool>       clear failure records, switch back to members[0]
 *
 * API keys are only read into process memory from auth.json / models.json.
 * They are never logged, printed, or written to any file by this extension.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSimple as dispatch } from "@earendil-works/pi-ai/compat";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadConfig, type PoolConfig } from "./src/config.ts";
import { escapeConfigValueLiteral, resolveConfigValue, resolveMemberKey } from "./src/keys.ts";
import { loadModelsFile, type ModelsFileModel, type ModelsFileProvider } from "./src/models-file.ts";
import { createPoolStreamSimple, type PoolMember } from "./src/router.ts";
import { StateStore } from "./src/state.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface RegisteredPool {
	id: string;
	config: PoolConfig;
	members: PoolMember[];
}

function toProviderModelConfig(model: ModelsFileModel, provider: ModelsFileProvider): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		...(model.api ?? provider.api ? { api: (model.api ?? provider.api) as Api } : {}),
		...(model.baseUrl ?? provider.baseUrl ? { baseUrl: model.baseUrl ?? provider.baseUrl } : {}),
		reasoning: model.reasoning ?? false,
		...(model.thinkingLevelMap
			? { thinkingLevelMap: model.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"] }
			: {}),
		input: model.input ?? ["text"],
		cost: model.cost ?? ZERO_COST,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 8192,
		...(model.headers ? { headers: model.headers } : {}),
		...(model.compat ? { compat: model.compat as ProviderModelConfig["compat"] } : {}),
	};
}

export default async function piMoreKeys(pi: ExtensionAPI): Promise<void> {
	const agentDir = process.env.PI_MORE_KEYS_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = join(agentDir, "pi-more-keys.json");
	if (!existsSync(configPath)) {
		// No pools configured: extension is a no-op.
		return;
	}

	const warnings: string[] = [];
	let config;
	try {
		config = loadConfig(configPath);
	} catch (error) {
		warnings.push(error instanceof Error ? error.message : String(error));
		config = { version: 1 as const, pools: {} };
	}

	const modelsFile = loadModelsFile(join(agentDir, "models.json"));
	const authPath = join(agentDir, "auth.json");
	const state = new StateStore(join(agentDir, "pi-more-keys-state.json"));
	const pools: RegisteredPool[] = [];

	for (const [routerId, poolConfig] of Object.entries(config.pools)) {
		const members: PoolMember[] = [];
		for (const memberId of poolConfig.members) {
			const def = modelsFile.providers[memberId];
			if (!def) {
				warnings.push(`pool "${routerId}": member "${memberId}" not found in models.json, skipped`);
				continue;
			}
			const apiKey = resolveMemberKey(memberId, { authPath, providerApiKey: def.apiKey });
			if (!apiKey) {
				warnings.push(`pool "${routerId}": no API key for member "${memberId}" (auth.json or models.json), skipped`);
				continue;
			}
			const headers = def.headers
				? Object.fromEntries(
						Object.entries(def.headers)
							.map(([k, v]) => [k, resolveConfigValue(v)] as const)
							.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
					)
				: undefined;
			members.push({
				id: memberId,
				apiKey,
				...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
				...(def.api ? { api: def.api as Api } : {}),
				...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			});
		}

		if (members.length === 0) {
			warnings.push(`pool "${routerId}": no usable members, router provider not registered`);
			continue;
		}

		// Model metadata is copied from the first config member that exists in models.json.
		const modelSourceId =
			poolConfig.members.find((id) => (modelsFile.providers[id]?.models?.length ?? 0) > 0) ?? members[0]!.id;
		const modelSource = modelsFile.providers[modelSourceId]!;
		const routerModels = (modelSource.models ?? []).map((m) => toProviderModelConfig(m, modelSource));
		if (routerModels.length === 0) {
			warnings.push(`pool "${routerId}": member "${modelSourceId}" declares no models, router provider not registered`);
			continue;
		}
		const routerApi = (modelSource.api ?? routerModels[0]!.api) as Api | undefined;
		if (!routerApi || !modelSource.baseUrl) {
			warnings.push(`pool "${routerId}": member "${modelSourceId}" needs baseUrl and api, router provider not registered`);
			continue;
		}

		const pool: RegisteredPool = { id: routerId, config: poolConfig, members };
		pools.push(pool);

		pi.registerProvider(routerId, {
			name: routerId,
			baseUrl: modelSource.baseUrl,
			api: routerApi,
			// Marks the provider as having auth so models are listed/usable. The
			// router overrides the key per attempt; escaped so pi's config value
			// resolution returns it unchanged.
			apiKey: escapeConfigValueLiteral(members[0]!.apiKey),
			models: routerModels,
			streamSimple: createPoolStreamSimple({
				pool: {
					id: routerId,
					members,
					trigger: poolConfig.trigger,
					maxAlternateAttempts: poolConfig.maxAlternateAttempts,
				},
				state,
				dispatch,
			}),
		});
	}

	pi.registerCommand("more-keys", {
		description: "Show pi-more-keys pools: active member and failure records",
		handler: async (_args, ctx) => {
			if (pools.length === 0) {
				ctx.ui.notify("pi-more-keys: no pools registered (check config and warnings)", "warning");
				return;
			}
			const lines: string[] = [];
			for (const pool of pools) {
				const poolState = state.getPool(pool.id);
				const active =
					poolState.active && pool.members.some((m) => m.id === poolState.active)
						? poolState.active
						: pool.members[0]!.id;
				lines.push(`${pool.id}: active=${active} members=[${pool.members.map((m) => m.id).join(", ")}]`);
				const failures = Object.entries(poolState.failed);
				if (failures.length === 0) {
					lines.push("  no failure records");
				} else {
					for (const [memberId, failure] of failures) {
						lines.push(`  failed: ${memberId} reason=${failure.reason} at=${new Date(failure.at).toISOString()}`);
					}
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("more-keys-use", {
		description: "Switch a pool's active member: /more-keys-use <pool> <member>",
		handler: async (args, ctx) => {
			const [poolId, memberId] = args.trim().split(/\s+/);
			const pool = pools.find((p) => p.id === poolId);
			if (!pool || !memberId) {
				ctx.ui.notify("usage: /more-keys-use <pool> <member>", "warning");
				return;
			}
			if (!pool.members.some((m) => m.id === memberId)) {
				ctx.ui.notify(`pool "${poolId}" has no member "${memberId}"`, "error");
				return;
			}
			state.update((data) => {
				const p = (data.pools[poolId!] ??= { failed: {} });
				p.active = memberId;
				delete p.failed[memberId!];
			});
			ctx.ui.notify(`pool "${poolId}": active switched to ${memberId}`, "info");
		},
	});

	pi.registerCommand("more-keys-reset", {
		description: "Clear a pool's failure records and switch back to its first member: /more-keys-reset <pool>",
		handler: async (args, ctx) => {
			const poolId = args.trim();
			const pool = pools.find((p) => p.id === poolId);
			if (!pool) {
				ctx.ui.notify(`unknown pool "${poolId}"`, "error");
				return;
			}
			const first = pool.members[0]!.id;
			state.update((data) => {
				data.pools[poolId] = { active: first, failed: {} };
			});
			ctx.ui.notify(`pool "${poolId}": reset, active=${first}`, "info");
		},
	});

	if (warnings.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			for (const warning of warnings) {
				ctx.ui.notify(`pi-more-keys: ${warning}`, "warning");
			}
		});
	}
}
