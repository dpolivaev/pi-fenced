import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
	DEFAULT_PRESET_FILE_NAME,
	DEFAULT_PRESET_NAME,
	SELECTION_FILE_NAME,
	type ResolvedFencePaths,
} from "./path-resolution.ts";

interface SelectionFile {
	selectedPreset: string;
}

interface PresetFileOps {
	existsSync: (pathValue: string) => boolean;
	mkdirSync: (pathValue: string) => void;
	readFileSync: (pathValue: string) => string;
	readdirSync: (pathValue: string) => string[];
	writeFileSync: (pathValue: string, content: string) => void;
}

function defaultFileOps(): PresetFileOps {
	return {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		readdirSync,
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isValidPresetName(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export function buildSelectionFileContent(selectedPreset: string): string {
	if (!isValidPresetName(selectedPreset)) {
		throw new Error(`Invalid preset name: ${selectedPreset}`);
	}

	return `${JSON.stringify({ selectedPreset } satisfies SelectionFile, null, 2)}\n`;
}

export function parseSelectionFileContent(rawContent: string): { selectedPreset: string } {
	let parsedValue: unknown;
	try {
		parsedValue = JSON.parse(rawContent);
	} catch (error) {
		throw new Error(
			`Invalid preset selection metadata: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (!isRecord(parsedValue)) {
		throw new Error("Invalid preset selection metadata: expected JSON object");
	}

	const selectedPreset = parsedValue.selectedPreset;
	if (typeof selectedPreset !== "string" || !isValidPresetName(selectedPreset.trim())) {
		throw new Error("Invalid preset selection metadata: selectedPreset must be a valid preset name");
	}

	return {
		selectedPreset: selectedPreset.trim(),
	};
}

export function resolvePresetPath(presetsDirectoryPath: string, presetName: string): string {
	if (!isValidPresetName(presetName)) {
		throw new Error(`Invalid preset name: ${presetName}`);
	}

	return join(presetsDirectoryPath, `${presetName}.json`);
}

export function inferPresetNameFromPath(pathValue: string): string | undefined {
	const fileName = basename(pathValue);
	if (!fileName.endsWith(".json")) {
		return undefined;
	}

	const presetName = fileName.slice(0, -".json".length);
	return isValidPresetName(presetName) ? presetName : undefined;
}

export function listGlobalPresetNames(
	presetsDirectoryPath: string,
	fileOps: PresetFileOps = defaultFileOps(),
): string[] {
	if (!fileOps.existsSync(presetsDirectoryPath)) {
		return [];
	}

	const names = new Set<string>();
	for (const entry of fileOps.readdirSync(presetsDirectoryPath)) {
		if (extname(entry) !== ".json") {
			continue;
		}

		const presetName = entry.slice(0, -".json".length);
		if (!isValidPresetName(presetName)) {
			continue;
		}
		names.add(presetName);
	}

	return [...names].sort();
}

export function readSelectedPresetName(
	selectionPath: string,
	fileOps: PresetFileOps = defaultFileOps(),
): string {
	if (!fileOps.existsSync(selectionPath)) {
		throw new Error(`Preset selection metadata is missing: ${selectionPath}`);
	}

	return parseSelectionFileContent(fileOps.readFileSync(selectionPath)).selectedPreset;
}

export function writeSelectedPresetName(
	selectionPath: string,
	selectedPreset: string,
	fileOps: PresetFileOps = defaultFileOps(),
): void {
	const content = buildSelectionFileContent(selectedPreset);
	fileOps.mkdirSync(dirname(selectionPath));
	fileOps.writeFileSync(selectionPath, content);
}

export function resolveSelectedGlobalPreset(
	paths: Pick<ResolvedFencePaths, "presetsDirectoryPath" | "selectionPath">,
	fileOps: PresetFileOps = defaultFileOps(),
): { presetName: string; presetPath: string } {
	const presetName = readSelectedPresetName(paths.selectionPath, fileOps);
	const presetPath = resolvePresetPath(paths.presetsDirectoryPath, presetName);
	if (!fileOps.existsSync(presetPath)) {
		throw new Error(`Selected preset "${presetName}" does not exist at ${presetPath}`);
	}

	return {
		presetName,
		presetPath,
	};
}

export { DEFAULT_PRESET_FILE_NAME, DEFAULT_PRESET_NAME, SELECTION_FILE_NAME };
