import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PI_FENCED_ACTIVE_LAUNCH_STATE_PATH_ENV =
	"PI_FENCED_ACTIVE_LAUNCH_STATE_PATH";

const DEFAULT_RUNTIME_ROOT = "/tmp/pi-fenced";

interface ActiveLaunchState {
	sessionFile?: string;
	activeGlobalPresetPath?: string;
	updatedAt: string;
}

export interface ActiveLaunchStateFileOps {
	existsSync: (pathValue: string) => boolean;
	mkdirSync: (pathValue: string) => void;
	readFileSync: (pathValue: string) => string;
	unlinkSync: (pathValue: string) => void;
	writeFileSync: (pathValue: string, content: string) => void;
}

export interface CreateActiveLaunchStatePathInput {
	runtimeRoot?: string;
	runId?: string;
}

function createDefaultRunId(): string {
	return `${process.pid}.${Date.now().toString(36)}.${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

export function createActiveLaunchStatePath(
	input: CreateActiveLaunchStatePathInput = {},
): string {
	const runtimeRoot = input.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
	const runId = input.runId ?? createDefaultRunId();
	return join(runtimeRoot, "runtime", `active-launch.${runId}.json`);
}

function defaultFileOps(): ActiveLaunchStateFileOps {
	return {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		unlinkSync,
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	};
}

function readLaunchState(
	statePath: string,
	fileOps: ActiveLaunchStateFileOps,
): Partial<ActiveLaunchState> | undefined {
	if (!fileOps.existsSync(statePath)) {
		return undefined;
	}

	let content: string;
	try {
		content = fileOps.readFileSync(statePath);
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}

	if (!parsed || typeof parsed !== "object") {
		return undefined;
	}

	return parsed as Partial<ActiveLaunchState>;
}

function normalizeOptionalPath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function writeLaunchState(
	statePath: string,
	state: Partial<ActiveLaunchState>,
	fileOps: ActiveLaunchStateFileOps,
): void {
	const sessionFile = normalizeOptionalPath(state.sessionFile);
	const activeGlobalPresetPath = normalizeOptionalPath(state.activeGlobalPresetPath);
	if (!sessionFile && !activeGlobalPresetPath) {
		if (fileOps.existsSync(statePath)) {
			fileOps.unlinkSync(statePath);
		}
		return;
	}

	const content = `${JSON.stringify(
		{
			...(sessionFile ? { sessionFile } : {}),
			...(activeGlobalPresetPath ? { activeGlobalPresetPath } : {}),
			updatedAt: new Date().toISOString(),
		} satisfies ActiveLaunchState,
		null,
		2,
	)}\n`;

	fileOps.mkdirSync(dirname(statePath));
	fileOps.writeFileSync(statePath, content);
}

export function initializeActiveLaunchState(
	statePath: string,
	activeGlobalPresetPath: string,
	fileOps: ActiveLaunchStateFileOps = defaultFileOps(),
): void {
	writeLaunchState(statePath, { activeGlobalPresetPath }, fileOps);
}

export function readActiveLaunchSessionPath(
	statePath: string,
	fileOps: ActiveLaunchStateFileOps = defaultFileOps(),
): string | undefined {
	const state = readLaunchState(statePath, fileOps);
	return normalizeOptionalPath(state?.sessionFile);
}

export function readActiveLaunchPresetPath(
	statePath: string,
	fileOps: ActiveLaunchStateFileOps = defaultFileOps(),
): string | undefined {
	const state = readLaunchState(statePath, fileOps);
	return normalizeOptionalPath(state?.activeGlobalPresetPath);
}

export function writeActiveLaunchSessionPath(
	statePath: string,
	sessionFile: string | undefined,
	fileOps: ActiveLaunchStateFileOps = defaultFileOps(),
): void {
	const previousState = readLaunchState(statePath, fileOps);
	writeLaunchState(
		statePath,
		{
			sessionFile,
			activeGlobalPresetPath: previousState?.activeGlobalPresetPath,
		},
		fileOps,
	);
}
