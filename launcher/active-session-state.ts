import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PI_FENCED_ACTIVE_SESSION_STATE_PATH_ENV =
	"PI_FENCED_ACTIVE_SESSION_STATE_PATH";

const DEFAULT_RUNTIME_ROOT = "/tmp/pi-fenced";

interface ActiveSessionState {
	sessionFile: string;
	updatedAt: string;
}

export interface ActiveSessionStateFileOps {
	existsSync: (pathValue: string) => boolean;
	mkdirSync: (pathValue: string) => void;
	readFileSync: (pathValue: string) => string;
	unlinkSync: (pathValue: string) => void;
	writeFileSync: (pathValue: string, content: string) => void;
}

export interface CreateActiveSessionStatePathInput {
	runtimeRoot?: string;
	runId?: string;
}

function createDefaultRunId(): string {
	return `${process.pid}.${Date.now().toString(36)}.${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

export function createActiveSessionStatePath(
	input: CreateActiveSessionStatePathInput = {},
): string {
	const runtimeRoot = input.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
	const runId = input.runId ?? createDefaultRunId();
	return join(runtimeRoot, "runtime", `active-session.${runId}.json`);
}

export function readTrackedSessionPath(
	statePath: string,
	fileOps: ActiveSessionStateFileOps = {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		unlinkSync,
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): string | undefined {
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

	const sessionFile = (parsed as Partial<ActiveSessionState>).sessionFile;
	if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) {
		return undefined;
	}

	return sessionFile;
}

export function writeTrackedSessionPath(
	statePath: string,
	sessionFile: string | undefined,
	fileOps: ActiveSessionStateFileOps = {
		existsSync,
		mkdirSync: (pathValue) => mkdirSync(pathValue, { recursive: true }),
		readFileSync: (pathValue) => readFileSync(pathValue, "utf-8"),
		unlinkSync,
		writeFileSync: (pathValue, content) => writeFileSync(pathValue, content, "utf-8"),
	},
): void {
	if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) {
		if (fileOps.existsSync(statePath)) {
			fileOps.unlinkSync(statePath);
		}
		return;
	}

	const content = `${JSON.stringify(
		{
			sessionFile,
			updatedAt: new Date().toISOString(),
		} satisfies ActiveSessionState,
		null,
		2,
	)}\n`;

	fileOps.mkdirSync(dirname(statePath));
	fileOps.writeFileSync(statePath, content);
}
