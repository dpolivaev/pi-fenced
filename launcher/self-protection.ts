import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedFencePaths } from "./path-resolution.ts";

const DEFAULT_RUNTIME_ROOT = "/tmp/pi-fenced";
const LOCKED_SETTINGS_FILE_NAME = "launcher-locked-settings.json";

export interface SelfProtectionInput {
	fencePaths: Pick<ResolvedFencePaths, "globalConfigPath" | "fenceBaseConfigPath">;
	projectRoot?: string;
	runtimeRoot?: string;
}

export interface SelfProtectionResult {
	settingsPath: string;
	protectedWritePaths: string[];
}

export interface SelfProtectionFileOps {
	mkdirSync: (pathValue: string) => void;
	writeFileSync: (pathValue: string, content: string) => void;
}

function getDefaultProjectRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function normalizeAbsolute(pathValue: string): string {
	return resolve(pathValue);
}

function dedupePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];

	for (const pathValue of paths) {
		const normalizedPath = normalizeAbsolute(pathValue);
		if (seen.has(normalizedPath)) {
			continue;
		}
		seen.add(normalizedPath);
		unique.push(normalizedPath);
	}

	return unique;
}

export function computeProtectedWritePaths(input: SelfProtectionInput): string[] {
	const projectRoot = normalizeAbsolute(input.projectRoot ?? getDefaultProjectRoot());
	const globalConfigPath = normalizeAbsolute(input.fencePaths.globalConfigPath);
	const fenceBaseConfigPath = normalizeAbsolute(input.fencePaths.fenceBaseConfigPath);

	return dedupePaths([
		join(projectRoot, "launcher"),
		join(projectRoot, "apply"),
		globalConfigPath,
		dirname(globalConfigPath),
		fenceBaseConfigPath,
		dirname(fenceBaseConfigPath),
	]);
}

export function buildLockedSettingsContent(
	baseConfigPath: string,
	protectedWritePaths: string[],
): string {
	const content = {
		extends: normalizeAbsolute(baseConfigPath),
		filesystem: {
			denyWrite: protectedWritePaths,
		},
	};

	return `${JSON.stringify(content, null, 2)}\n`;
}

export function writeLockedSettingsFile(
	input: SelfProtectionInput,
	fileOps: SelfProtectionFileOps = {
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): SelfProtectionResult {
	const runtimeRoot = normalizeAbsolute(input.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
	const settingsPath = join(runtimeRoot, "runtime", LOCKED_SETTINGS_FILE_NAME);
	const protectedWritePaths = computeProtectedWritePaths(input);
	const content = buildLockedSettingsContent(input.fencePaths.globalConfigPath, protectedWritePaths);

	fileOps.mkdirSync(dirname(settingsPath));
	fileOps.writeFileSync(settingsPath, content);

	return {
		settingsPath,
		protectedWritePaths,
	};
}
