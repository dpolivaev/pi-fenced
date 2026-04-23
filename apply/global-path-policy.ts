import { resolve } from "node:path";
import { resolveFencePaths } from "../launcher/path-resolution.ts";
import type { FenceConfigApplyRequest } from "./request-contract.ts";

export interface GlobalTargetPolicyInput {
	request: FenceConfigApplyRequest;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export interface GlobalTargetPolicyResult {
	expectedTargetPath: string;
}

export function assertGlobalTargetPolicy(input: GlobalTargetPolicyInput): GlobalTargetPolicyResult {
	if (input.request.scope !== "global") {
		throw new Error(`Global apply only supports scope=global (received ${input.request.scope})`);
	}

	const expectedTargetPath = resolveFencePaths({
		env: input.env,
		homeDir: input.homeDir,
	}).globalConfigPath;

	if (resolve(input.request.targetPath) !== resolve(expectedTargetPath)) {
		throw new Error(
			`Request target path mismatch. Expected ${expectedTargetPath}, got ${input.request.targetPath}`,
		);
	}

	return { expectedTargetPath };
}
