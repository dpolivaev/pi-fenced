import { spawnSync } from "node:child_process";

export interface LaunchSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

export interface BuildLaunchSpecInput {
	withoutFence: boolean;
	fenceMonitor: boolean;
	configPath?: string;
	piArgs: string[];
	baseEnv?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
	exitCode: number;
}

export interface ChildRunnerResult {
	status: number | null;
	error?: Error;
}

export type ChildRunner = (
	command: string,
	args: string[],
	options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => ChildRunnerResult;

export function buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
	const env: NodeJS.ProcessEnv = {
		...(input.baseEnv ?? process.env),
		PI_FENCED_LAUNCHER: "1",
	};

	if (input.withoutFence) {
		return {
			command: "pi",
			args: [...input.piArgs],
			env,
		};
	}

	if (!input.configPath) {
		throw new Error("configPath is required for fenced mode");
	}

	const args: string[] = [];
	if (input.fenceMonitor) {
		args.push("-m");
	}
	args.push("--settings", input.configPath, "--", "pi", ...input.piArgs);

	return {
		command: "fence",
		args,
		env,
	};
}

export function runLaunchSpec(
	spec: LaunchSpec,
	runner: ChildRunner = (command, args, options) => {
		const result = spawnSync(command, args, {
			stdio: options.stdio,
			env: options.env,
		});
		return {
			status: result.status,
			error: result.error,
		};
	},
): LaunchResult {
	const result = runner(spec.command, spec.args, {
		stdio: "inherit",
		env: spec.env,
	});

	if (result.error) {
		throw result.error;
	}

	return {
		exitCode: result.status ?? 1,
	};
}
