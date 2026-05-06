import { homedir } from "node:os";
import { join } from "node:path";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface ResolveFencePathsInput {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface ResolvedFencePaths {
	agentDir: string;
	fenceBaseConfigPath: string;
	globalConfigPath: string;
	preferencesPath: string;
}

function expandHomePath(pathValue: string, homeDir: string): string {
	if (pathValue === "~") {
		return homeDir;
	}

	if (pathValue.startsWith("~/")) {
		return `${homeDir}${pathValue.slice(1)}`;
	}

	return pathValue;
}

export function resolveAgentDir(input: ResolveFencePathsInput = {}): string {
	const env = input.env ?? process.env;
	const resolvedHome = input.homeDir ?? homedir();
	const envValue = env[PI_AGENT_DIR_ENV];

	if (typeof envValue === "string" && envValue.trim().length > 0) {
		return expandHomePath(envValue.trim(), resolvedHome);
	}

	return join(resolvedHome, ".pi", "agent");
}

export function resolveFencePaths(input: ResolveFencePathsInput = {}): ResolvedFencePaths {
	const resolvedHome = input.homeDir ?? homedir();
	const agentDir = resolveAgentDir(input);

	return {
		agentDir,
		fenceBaseConfigPath: join(resolvedHome, ".config", "fence", "fence.json"),
		globalConfigPath: join(agentDir, "fence", "global.json"),
		preferencesPath: join(agentDir, "pi-fenced", "preferences.json"),
	};
}
