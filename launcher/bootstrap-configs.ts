import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildSelectionFileContent, DEFAULT_PRESET_NAME } from "./global-presets.ts";
import type { ResolvedFencePaths } from "./path-resolution.ts";

export const FENCE_BASE_BOOTSTRAP_CONTENT = '{"extends":"code"}\n';
export const DEFAULT_PRESET_BOOTSTRAP_CONTENT = '{"extends":"@base"}\n';

export interface BootstrapFileOps {
	existsSync: (path: string) => boolean;
	mkdirSync: (path: string) => void;
	writeFileSync: (path: string, content: string) => void;
}

export interface BootstrapResult {
	createdFenceBaseConfig: boolean;
	createdDefaultPreset: boolean;
	createdSelectionMetadata: boolean;
}

function ensureBootstrapFile(
	pathValue: string,
	content: string,
	fileOps: BootstrapFileOps,
): boolean {
	if (fileOps.existsSync(pathValue)) {
		return false;
	}

	fileOps.mkdirSync(dirname(pathValue));
	fileOps.writeFileSync(pathValue, content);
	return true;
}

export function ensureBootstrapConfigs(
	paths: Pick<ResolvedFencePaths, "fenceBaseConfigPath" | "defaultPresetPath" | "selectionPath">,
	fileOps: BootstrapFileOps = {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): BootstrapResult {
	const createdFenceBaseConfig = ensureBootstrapFile(
		paths.fenceBaseConfigPath,
		FENCE_BASE_BOOTSTRAP_CONTENT,
		fileOps,
	);
	const createdDefaultPreset = ensureBootstrapFile(
		paths.defaultPresetPath,
		DEFAULT_PRESET_BOOTSTRAP_CONTENT,
		fileOps,
	);
	const createdSelectionMetadata = ensureBootstrapFile(
		paths.selectionPath,
		buildSelectionFileContent(DEFAULT_PRESET_NAME),
		fileOps,
	);

	return {
		createdFenceBaseConfig,
		createdDefaultPreset,
		createdSelectionMetadata,
	};
}
