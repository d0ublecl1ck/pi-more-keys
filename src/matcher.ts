/**
 * Trigger matching: decide whether a failed attempt should mark a member as
 * failed and allow failover to the next member.
 */

import type { TriggerConfig } from "./config.ts";

export interface TriggerInput {
	/** HTTP status captured via onResponse, if the request got that far. */
	status?: number;
	/** Error message from the stream error event, if any. */
	errorMessage?: string;
}

export interface TriggerMatch {
	matched: boolean;
	/** Short reason persisted into state, e.g. "429" or 'keyword:"rate limit"'. Never contains secrets. */
	reason?: string;
}

export function matchesTrigger(trigger: TriggerConfig, input: TriggerInput): TriggerMatch {
	if (input.status !== undefined && trigger.httpStatuses.includes(input.status)) {
		return { matched: true, reason: String(input.status) };
	}
	const message = input.errorMessage;
	if (message && trigger.errorKeywords.length > 0) {
		const haystack = trigger.caseInsensitive ? message.toLowerCase() : message;
		for (const keyword of trigger.errorKeywords) {
			if (keyword.length === 0) continue;
			const needle = trigger.caseInsensitive ? keyword.toLowerCase() : keyword;
			if (haystack.includes(needle)) {
				return { matched: true, reason: `keyword:${JSON.stringify(keyword)}` };
			}
		}
	}
	return { matched: false };
}
