import { spawnSync } from "node:child_process";

export interface FenceValidationResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

export type FenceValidator = (args: string[]) => FenceValidationResult;

export function validateFenceConfig(
	configPath: string,
	validator: FenceValidator = (args) => {
		const result = spawnSync("fence", args, {
			encoding: "utf8",
			stdio: "pipe",
		});
		return {
			exitCode: result.status ?? 1,
			stderr: result.stderr ?? "",
			stdout: result.stdout ?? "",
		};
	},
): void {
	const result = validator(["config", "show", "--settings", configPath]);
	if (result.exitCode === 0) {
		return;
	}

	const stderr = result.stderr.trim();
	const message = stderr.length > 0 ? stderr : `Fence config validation failed for ${configPath}`;
	throw new Error(message);
}
