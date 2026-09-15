/**
 * Minimal reader for ~/.pi/agent/models.json: pi-more-keys only needs each
 * member provider's baseUrl / api / apiKey / headers and its model list.
 */

import { existsSync, readFileSync } from "node:fs";

export interface ModelsFileModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
}

export interface ModelsFileProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models?: ModelsFileModel[];
}

export interface ModelsFile {
	providers: Record<string, ModelsFileProvider>;
}

/** Load models.json. Returns an empty providers map when the file is missing or malformed. */
export function loadModelsFile(path: string): ModelsFile {
	if (!existsSync(path)) {
		return { providers: {} };
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			return { providers: {} };
		}
		const providers = (parsed as Record<string, unknown>).providers;
		if (typeof providers !== "object" || providers === null) {
			return { providers: {} };
		}
		return { providers: providers as Record<string, ModelsFileProvider> };
	} catch {
		return { providers: {} };
	}
}
