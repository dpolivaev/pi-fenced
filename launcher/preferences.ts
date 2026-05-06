import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LauncherPreferences {
	allowMacosPasteboard: boolean;
}

export interface LauncherPreferencesFileOps {
	existsSync: (pathValue: string) => boolean;
	mkdirSync: (pathValue: string) => void;
	readFileSync: (pathValue: string) => string;
	writeFileSync: (pathValue: string, content: string) => void;
}

const DEFAULT_LAUNCHER_PREFERENCES: LauncherPreferences = {
	allowMacosPasteboard: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readLauncherPreferences(
	preferencesPath: string,
	fileOps: LauncherPreferencesFileOps = {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): LauncherPreferences {
	if (!fileOps.existsSync(preferencesPath)) {
		return { ...DEFAULT_LAUNCHER_PREFERENCES };
	}

	let content: string;
	try {
		content = fileOps.readFileSync(preferencesPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to read launcher preferences ${preferencesPath}: ${message}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid launcher preferences file ${preferencesPath}: bad JSON`);
	}

	if (!isRecord(parsed)) {
		throw new Error(
			`Invalid launcher preferences file ${preferencesPath}: expected object JSON`,
		);
	}

	const allowMacosPasteboard = parsed.allowMacosPasteboard;
	if (allowMacosPasteboard === undefined) {
		return { ...DEFAULT_LAUNCHER_PREFERENCES };
	}

	if (typeof allowMacosPasteboard !== "boolean") {
		throw new Error(
			`Invalid launcher preferences file ${preferencesPath}: allowMacosPasteboard must be boolean`,
		);
	}

	return {
		allowMacosPasteboard,
	};
}

export function writeLauncherPreferences(
	preferencesPath: string,
	preferences: LauncherPreferences,
	fileOps: LauncherPreferencesFileOps = {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): void {
	const content = `${JSON.stringify(preferences, null, 2)}\n`;
	fileOps.mkdirSync(dirname(preferencesPath));
	fileOps.writeFileSync(preferencesPath, content);
}
