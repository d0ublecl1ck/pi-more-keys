/**
 * pi-more-keys — zero-config multi-key failover for any api_key provider in pi.
 *
 * Users add providers the usual way (models.json + /login). One extra step —
 * `/add-more-key <provider-id>` — pools an additional key, and from then on
 * the provider's requests fail over across all pooled keys on trigger errors
 * (HTTP status / error keyword), with the active key persisted across
 * restarts in ~/.pi/agent/pi-more-keys-state.json.
 *
 * How it works: for every provider with pooled extra keys this extension
 * overrides ONLY streamSimple via pi.registerProvider() (merge semantics:
 * models.json models/baseUrl stay intact). The override replays the request
 * against the same endpoint with each pooled key until one succeeds.
 *
 * Keys live in ~/.pi/agent/pi-more-keys.json (mode 0600) and process memory.
 * They are never logged, printed, or written anywhere else; the state file
 * records key INDICES only.
 *
 * Commands:
 *   /add-more-key [provider-id]   pool an extra key (prompted via UI dialog);
 *                                 no argument = current model's provider
 *   /more-keys                    show key counts, active key index, failures
 *   /more-keys-reset <provider>   clear failure records, switch back to key #0
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getApiProvider, streamSimple as dispatch } from "@earendil-works/pi-ai/compat";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAddKeyFlow } from "./src/add-key.ts";
import { KeyPoolStore, loadPoolFile } from "./src/pool-file.ts";
import { createKeyPoolStream } from "./src/router.ts";
import { StateStore } from "./src/state.ts";

/** Minimal models.json read: provider id -> api, for startup-time dispatchability checks. */
function readModelsFileApis(path: string): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		const providers = (parsed as Record<string, unknown>).providers;
		if (typeof providers !== "object" || providers === null) return {};
		const apis: Record<string, string> = {};
		for (const [id, def] of Object.entries(providers as Record<string, { api?: unknown }>)) {
			if (typeof def?.api === "string") apis[id] = def.api;
		}
		return apis;
	} catch {
		return {};
	}
}

/** The api a provider's models run on, via the live model registry. */
function apiFromRegistry(ctx: ExtensionContext, providerId: string): string | undefined {
	return ctx.modelRegistry.getProvider(providerId)?.getModels()[0]?.api;
}

export default async function piMoreKeys(pi: ExtensionAPI): Promise<void> {
	const agentDir = process.env.PI_MORE_KEYS_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const poolPath = join(agentDir, "pi-more-keys.json");
	const { data, warnings } = loadPoolFile(poolPath);
	const store = new KeyPoolStore(poolPath, data);
	const state = new StateStore(join(agentDir, "pi-more-keys-state.json"));

	const overridden = new Set<string>();
	const startupWarnings = [...warnings];
	/** Providers with pooled keys whose api could not be checked at factory time. */
	const deferred: string[] = [];

	/** Register the streamSimple override for a provider (idempotent, immediate effect). */
	const ensureOverride = (providerId: string, api: string): void => {
		if (overridden.has(providerId)) return;
		pi.registerProvider(providerId, {
			// registerProvider merges; models.json models/baseUrl are preserved.
			// api must be re-passed because pi requires it alongside streamSimple.
			api: api as Api,
			streamSimple: createKeyPoolStream({
				providerId,
				getEntry: () => store.getEntry(providerId),
				state,
				dispatch,
			}),
		});
		overridden.add(providerId);
	};

	// Startup pass: override every pooled provider whose api is known from models.json.
	const modelsApis = readModelsFileApis(join(agentDir, "models.json"));
	for (const [providerId, entry] of Object.entries(store.providers)) {
		if (entry.extraKeys.length === 0) continue;
		const api = modelsApis[providerId];
		if (!api) {
			deferred.push(providerId);
			continue;
		}
		// Double-check dispatchability before overriding: unsupported apis are skipped.
		if (!getApiProvider(api as Api)) {
			startupWarnings.push(
				`provider "${providerId}" uses api "${api}" which is not dispatchable; failover disabled for it`,
			);
			continue;
		}
		try {
			ensureOverride(providerId, api);
		} catch (error) {
			startupWarnings.push(
				`failed to override provider "${providerId}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		for (const warning of startupWarnings) {
			ctx.ui.notify(`pi-more-keys: ${warning}`, "warning");
		}
		// Backstop for providers not in models.json (e.g. built-ins): check the
		// api via the live model registry and register the override now.
		for (const providerId of deferred) {
			const entry = store.getEntry(providerId);
			if (!entry || entry.extraKeys.length === 0 || overridden.has(providerId)) continue;
			const api = apiFromRegistry(ctx, providerId);
			if (!api) {
				ctx.ui.notify(
					`pi-more-keys: cannot determine api for provider "${providerId}"; failover disabled for it`,
					"warning",
				);
				continue;
			}
			if (!getApiProvider(api as Api)) {
				ctx.ui.notify(
					`pi-more-keys: provider "${providerId}" uses api "${api}" which is not dispatchable; failover disabled for it`,
					"warning",
				);
				continue;
			}
			try {
				ensureOverride(providerId, api);
			} catch (error) {
				ctx.ui.notify(
					`pi-more-keys: failed to override provider "${providerId}": ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	});

	pi.registerCommand("add-more-key", {
		description: "Pool an extra API key for a provider (failover). No argument = current model's provider: /add-more-key [provider-id]",
		handler: async (args, ctx) => {
			await runAddKeyFlow({
				providerId: args,
				getCurrentProvider: () => ctx.model?.provider,
				getProviderApi: (id) => apiFromRegistry(ctx, id),
				isApiDispatchable: (api) => getApiProvider(api as Api) !== undefined,
				getOriginalKey: (id) => ctx.modelRegistry.getApiKeyForProvider(id),
				// Key is collected via UI dialog, never from command args, so it
				// does not end up in session history.
				promptKey: (providerId) =>
					ctx.ui.input(
						`Add extra API key for ${providerId}`,
						"paste the key — stored in pi-more-keys.json (0600), never logged",
					),
				getExtraKeys: (id) => store.getEntry(id)?.extraKeys ?? [],
				addKey: (id, key) => store.addExtraKey(id, key),
				ensureOverride,
				notify: (message, type) => ctx.ui.notify(message, type),
			});
		},
	});

	pi.registerCommand("more-keys", {
		description: "Show pooled providers: key count, active key index, failure records",
		handler: async (_args, ctx) => {
			const providerIds = Object.keys(store.providers);
			if (providerIds.length === 0) {
				ctx.ui.notify("pi-more-keys: no extra keys pooled yet — use /add-more-key <provider-id>", "info");
				return;
			}
			const lines: string[] = [];
			for (const providerId of providerIds) {
				const entry = store.getEntry(providerId)!;
				const totalKeys = 1 + entry.extraKeys.length;
				const providerState = state.getProvider(providerId);
				const active =
					providerState.active !== undefined && providerState.active < totalKeys
						? providerState.active
						: 0;
				const suffix = overridden.has(providerId) ? "" : " (override not active)";
				lines.push(`${providerId}: ${totalKeys} keys, active=#${active}${suffix}`);
				const failures = Object.entries(providerState.failed);
				if (failures.length === 0) {
					lines.push("  no failure records");
				} else {
					for (const [index, failure] of failures) {
						lines.push(`  key #${index} failed: reason=${failure.reason} at=${new Date(failure.at).toISOString()}`);
					}
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("more-keys-reset", {
		description: "Clear a provider's failure records and switch back to its original key: /more-keys-reset <provider-id>",
		handler: async (args, ctx) => {
			const providerId = args.trim();
			if (!store.getEntry(providerId)) {
				ctx.ui.notify(`pi-more-keys: no key pool for provider "${providerId}"`, "error");
				return;
			}
			state.update((data) => {
				data.providers[providerId] = { active: 0, failed: {} };
			});
			ctx.ui.notify(`pi-more-keys: "${providerId}" reset, active key #0`, "info");
		},
	});
}
