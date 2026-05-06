import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedFencePaths } from "./path-resolution.ts";

const DEFAULT_RUNTIME_ROOT = "/tmp/pi-fenced";
const LOCKED_SETTINGS_FILE_PREFIX = "launcher-locked-settings";
const LOCKED_SETTINGS_FILE_SUFFIX = ".json";
const DEFAULT_STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SelfProtectionInput {
	fencePaths: Pick<ResolvedFencePaths, "globalConfigPath" | "fenceBaseConfigPath">;
	projectRoot?: string;
	runtimeRoot?: string;
	runId?: string;
	launcherPreferencesPath?: string;
	includeDenyWrite?: boolean;
	enableMacosPasteboard?: boolean;
}

export interface SelfProtectionResult {
	settingsPath: string;
	protectedWritePaths: string[];
}

export const MACOS_PASTEBOARD_MACH_LOOKUPS = [
	"com.apple.pasteboard.1",
	"com.apple.pbs.fetch_services",
	"com.apple.coreservices.uasharedpasteboardmanager.xpc",
	"com.apple.coreservices.uasharedpasteboardaux.xpc",
	"com.apple.coreservices.uauseractivitypasteboardclient.xpc",
	"com.apple.coreservices.uasharedpasteboardprogressui.xpc",
] as const;

export interface PruneLockedSettingsInput {
	runtimeRoot?: string;
	nowMs?: number;
	maxAgeMs?: number;
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
	const launcherPreferencesPath = input.launcherPreferencesPath
		? normalizeAbsolute(input.launcherPreferencesPath)
		: undefined;

	return dedupePaths([
		projectRoot,
		globalConfigPath,
		dirname(globalConfigPath),
		fenceBaseConfigPath,
		dirname(fenceBaseConfigPath),
		...(launcherPreferencesPath
			? [launcherPreferencesPath, dirname(launcherPreferencesPath)]
			: []),
	]);
}

export function buildLockedSettingsContent(
	baseConfigPath: string,
	protectedWritePaths: string[],
	options: {
		enableMacosPasteboard?: boolean;
	} = {},
): string {
	const content: {
		extends: string;
		filesystem?: {
			denyWrite: string[];
		};
		macos?: {
			mach: {
				lookup: readonly string[];
			};
		};
	} = {
		extends: normalizeAbsolute(baseConfigPath),
	};

	if (protectedWritePaths.length > 0) {
		content.filesystem = {
			denyWrite: protectedWritePaths,
		};
	}

	if (options.enableMacosPasteboard) {
		content.macos = {
			mach: {
				lookup: MACOS_PASTEBOARD_MACH_LOOKUPS,
			},
		};
	}

	return `${JSON.stringify(content, null, 2)}\n`;
}

function getRunIdFromLockedSettingsFileName(fileName: string): string | undefined {
	if (!fileName.startsWith(`${LOCKED_SETTINGS_FILE_PREFIX}.`)) {
		return undefined;
	}
	if (!fileName.endsWith(LOCKED_SETTINGS_FILE_SUFFIX)) {
		return undefined;
	}
	const runId = fileName.slice(
		LOCKED_SETTINGS_FILE_PREFIX.length + 1,
		fileName.length - LOCKED_SETTINGS_FILE_SUFFIX.length,
	);
	return runId.length > 0 ? runId : undefined;
}

function parsePidFromRunId(runId: string): number | undefined {
	const firstToken = runId.split(".")[0]?.trim();
	if (!firstToken || !/^\d+$/.test(firstToken)) {
		return undefined;
	}
	const parsedPid = Number(firstToken);
	return Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			return true;
		}
		return false;
	}
}

export function pruneStaleLockedSettingsFiles(input: PruneLockedSettingsInput = {}): string[] {
	const runtimeRoot = normalizeAbsolute(input.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
	const runtimeDir = join(runtimeRoot, "runtime");
	const maxAgeMs = input.maxAgeMs ?? DEFAULT_STALE_LOCK_MAX_AGE_MS;
	const nowMs = input.nowMs ?? Date.now();

	if (!existsSync(runtimeDir)) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(runtimeDir);
	} catch {
		return [];
	}

	const removedPaths: string[] = [];
	for (const fileName of entries) {
		const runId = getRunIdFromLockedSettingsFileName(fileName);
		if (!runId) {
			continue;
		}

		const filePath = join(runtimeDir, fileName);
		let shouldRemove = false;
		try {
			const fileStat = statSync(filePath);
			if (!fileStat.isFile()) {
				continue;
			}
			const fileAgeMs = nowMs - fileStat.mtimeMs;
			shouldRemove = fileAgeMs > maxAgeMs;
		} catch {
			continue;
		}

		if (!shouldRemove) {
			continue;
		}

		const runPid = parsePidFromRunId(runId);
		if (runPid !== undefined && isProcessAlive(runPid)) {
			continue;
		}

		try {
			unlinkSync(filePath);
			removedPaths.push(filePath);
		} catch {
			// best-effort cleanup only
		}
	}

	return removedPaths;
}

function normalizeRunId(runId: string): string {
	const normalized = runId.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	if (normalized.length === 0) {
		throw new Error("runId must contain at least one valid character");
	}
	return normalized;
}

function generateDefaultRunId(): string {
	return `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

export function writeLockedSettingsFile(
	input: SelfProtectionInput,
	fileOps: SelfProtectionFileOps = {
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): SelfProtectionResult {
	const runtimeRoot = normalizeAbsolute(input.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
	const runId = normalizeRunId(input.runId ?? generateDefaultRunId());
	const settingsPath = join(
		runtimeRoot,
		"runtime",
		`${LOCKED_SETTINGS_FILE_PREFIX}.${runId}${LOCKED_SETTINGS_FILE_SUFFIX}`,
	);
	const protectedWritePaths =
		input.includeDenyWrite === false ? [] : computeProtectedWritePaths(input);
	const content = buildLockedSettingsContent(
		input.fencePaths.globalConfigPath,
		protectedWritePaths,
		{
			enableMacosPasteboard: input.enableMacosPasteboard,
		},
	);

	pruneStaleLockedSettingsFiles({
		runtimeRoot,
	});

	fileOps.mkdirSync(dirname(settingsPath));
	fileOps.writeFileSync(settingsPath, content);

	return {
		settingsPath,
		protectedWritePaths,
	};
}
