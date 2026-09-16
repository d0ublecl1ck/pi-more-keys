/**
 * /add-more-key flow: validation and pool mutation, with all pi/ui/file
 * interactions injected so the whole flow is unit-testable.
 *
 * Validation order (any failure → notify the reason, write nothing):
 * 1. The provider exists.
 * 2. Its api is dispatchable through the pi-ai compat api-registry.
 * 3. Its original key is resolvable (auth.json / env / models.json).
 *
 * The new key is collected via a UI prompt (never via command args, so it
 * does not land in session history), appended to the pool file (0600), and
 * the streamSimple override is registered immediately for the live session.
 */

export interface AddKeyFlowDeps {
	providerId: string;
	/** Resolve the provider's api id, or undefined when the provider is unknown / has no models. */
	getProviderApi: (providerId: string) => string | undefined;
	/** Whether pi-ai compat can dispatch this api (getApiProvider(api) !== undefined). */
	isApiDispatchable: (api: string) => boolean;
	/** Resolve the provider's original key, or undefined when none is configured. */
	getOriginalKey: (providerId: string) => Promise<string | undefined>;
	/** Prompt for the new key (UI input dialog). */
	promptKey: () => Promise<string | undefined>;
	/** Extra keys already pooled for this provider. */
	getExtraKeys: (providerId: string) => string[];
	/** Persist an extra key into the pool (0600 file). */
	addKey: (providerId: string, key: string) => void;
	/** Register (or no-op when already registered) the streamSimple override for the live session. */
	ensureOverride: (providerId: string, api: string) => void;
	notify: (message: string, type: "info" | "warning" | "error") => void;
}

export interface AddKeyFlowResult {
	added: boolean;
	/** Why the flow stopped without adding a key, for tests/logging. Never contains key material. */
	reason?: string;
	/** Total pooled key count (original + extras) after a successful add. */
	keyCount?: number;
}

export async function runAddKeyFlow(deps: AddKeyFlowDeps): Promise<AddKeyFlowResult> {
	const providerId = deps.providerId.trim();
	if (!providerId) {
		deps.notify("usage: /add-more-key <provider-id>", "warning");
		return { added: false, reason: "usage" };
	}

	const api = deps.getProviderApi(providerId);
	if (api === undefined) {
		deps.notify(
			`pi-more-keys: unknown provider "${providerId}" (no models found). Add it to models.json first.`,
			"error",
		);
		return { added: false, reason: "unknown-provider" };
	}

	if (!deps.isApiDispatchable(api)) {
		deps.notify(
			`pi-more-keys: provider "${providerId}" uses api "${api}" which has no dispatchable implementation; multi-key failover is not supported for it.`,
			"error",
		);
		return { added: false, reason: "undispatchable-api" };
	}

	const originalKey = await deps.getOriginalKey(providerId);
	if (!originalKey) {
		deps.notify(
			`pi-more-keys: no original key found for provider "${providerId}". Run /login ${providerId} or configure apiKey in models.json first.`,
			"error",
		);
		return { added: false, reason: "no-original-key" };
	}

	const input = await deps.promptKey();
	const key = input?.trim();
	if (!key) {
		deps.notify("pi-more-keys: cancelled (no key entered)", "info");
		return { added: false, reason: "cancelled" };
	}

	if (key === originalKey || deps.getExtraKeys(providerId).includes(key)) {
		deps.notify(`pi-more-keys: this key is already in the pool for "${providerId}"`, "warning");
		return { added: false, reason: "duplicate" };
	}

	deps.addKey(providerId, key);
	deps.ensureOverride(providerId, api);
	const keyCount = 1 + deps.getExtraKeys(providerId).length;
	deps.notify(`pi-more-keys: "${providerId}" now has ${keyCount} keys. Failover is active.`, "info");
	return { added: true, keyCount };
}
