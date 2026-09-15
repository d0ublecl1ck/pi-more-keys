import { describe, expect, it } from "vitest";
import type { TriggerConfig } from "../src/config.ts";
import { matchesTrigger } from "../src/matcher.ts";

const base: TriggerConfig = {
	httpStatuses: [401, 429, 500],
	errorKeywords: ["rate limit", "Overloaded"],
	caseInsensitive: true,
};

describe("matchesTrigger", () => {
	it("matches a configured HTTP status", () => {
		const result = matchesTrigger(base, { status: 429 });
		expect(result.matched).toBe(true);
		expect(result.reason).toBe("429");
	});

	it("does not match an unlisted HTTP status", () => {
		expect(matchesTrigger(base, { status: 400 }).matched).toBe(false);
	});

	it("matches error keywords case-insensitively by default", () => {
		const result = matchesTrigger(base, { errorMessage: "Request failed: RATE LIMIT exceeded" });
		expect(result.matched).toBe(true);
		expect(result.reason).toBe('keyword:"rate limit"');
	});

	it("matches mixed-case keywords against mixed-case messages", () => {
		expect(matchesTrigger(base, { errorMessage: "server is OVERLOADED right now" }).matched).toBe(true);
	});

	it("respects caseInsensitive: false", () => {
		const sensitive: TriggerConfig = { ...base, caseInsensitive: false };
		expect(matchesTrigger(sensitive, { errorMessage: "RATE LIMIT" }).matched).toBe(false);
		expect(matchesTrigger(sensitive, { errorMessage: "hit the rate limit" }).matched).toBe(true);
	});

	it("does not match when neither status nor keyword hits", () => {
		expect(matchesTrigger(base, { status: 400, errorMessage: "bad request" }).matched).toBe(false);
	});

	it("handles missing status and message", () => {
		expect(matchesTrigger(base, {}).matched).toBe(false);
		expect(matchesTrigger(base, { errorMessage: "" }).matched).toBe(false);
	});

	it("prefers the status reason when both status and keyword match", () => {
		const result = matchesTrigger(base, { status: 500, errorMessage: "rate limit" });
		expect(result.reason).toBe("500");
	});

	it("ignores empty keywords", () => {
		const trigger: TriggerConfig = { httpStatuses: [], errorKeywords: [""], caseInsensitive: true };
		expect(matchesTrigger(trigger, { errorMessage: "anything" }).matched).toBe(false);
	});
});
