import { extname, resolve } from "node:path";
import { resolveFencePaths } from "../launcher/path-resolution.ts";
import type { FenceConfigApplyRequest } from "./request-contract.ts";

export interface GlobalTargetPolicyInput {
	request: FenceConfigApplyRequest;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface GlobalTargetPolicyResult {
	expectedDirectoryPath: string;
}

export function assertGlobalTargetPolicy(input: GlobalTargetPolicyInput): GlobalTargetPolicyResult {
	if (input.request.scope !== "global") {
		throw new Error(`Global apply only supports scope=global (received ${input.request.scope})`);
	}

	const expectedDirectoryPath = resolveFencePaths({
		env: input.env,
		homeDir: input.homeDir,
	}).presetsDirectoryPath;
	const resolvedTargetPath = resolve(input.request.targetPath);
	const expectedDirectoryPrefix = `${resolve(expectedDirectoryPath)}/`;

	if (!resolvedTargetPath.startsWith(expectedDirectoryPrefix)) {
		throw new Error(
			`Global preset target must be inside ${expectedDirectoryPath}, got ${input.request.targetPath}`,
		);
	}

	if (extname(resolvedTargetPath) !== ".json") {
		throw new Error(`Global preset target must be a .json file: ${input.request.targetPath}`);
	}

	return { expectedDirectoryPath };
}
