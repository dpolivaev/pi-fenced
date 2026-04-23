import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { validateFenceConfig } from "../launcher/config-guard.ts";
import { applyReplaceWithRollback } from "./atomic-apply.ts";
import { assertGlobalTargetPolicy } from "./global-path-policy.ts";
import { isSuccessfulOutcome, type ApplyOutcome } from "./outcome.ts";
import { parseFenceConfigApplyRequest, type FenceConfigApplyRequest } from "./request-contract.ts";

export type ApplyDecision = "apply" | "reject";

export interface ApplyWorkflowPaths {
	controlDir: string;
	proposalsDir: string;
	backupsDir: string;
}

export interface ApplyWorkflowDependencies {
	validateFenceConfig: (configPath: string) => void;
	promptDecision: (input: {
		request: FenceConfigApplyRequest;
		diff: string;
	}) => Promise<ApplyDecision>;
	print: (message: string) => void;
	warn: (message: string) => void;
}

export interface RunPiFencedApplyInput {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	paths?: Partial<ApplyWorkflowPaths>;
	dependencies?: Partial<ApplyWorkflowDependencies>;
}

const DEFAULT_RUNTIME_ROOT = "/tmp/pi-fenced";
const REQUEST_FILE_PATTERN = /^request-(.+)\.json$/;

export const APPLY_CALLER_ENV_KEY = "PI_FENCED_APPLY_CALLER";
export const APPLY_CALLER_ENV_VALUE = "pi-fenced";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildDefaultPaths(): ApplyWorkflowPaths {
	return {
		controlDir: join(DEFAULT_RUNTIME_ROOT, "control"),
		proposalsDir: join(DEFAULT_RUNTIME_ROOT, "proposals"),
		backupsDir: join(DEFAULT_RUNTIME_ROOT, "backups"),
	};
}

export function isAuthorizedApplyCaller(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[APPLY_CALLER_ENV_KEY] === APPLY_CALLER_ENV_VALUE;
}

function listRequestPaths(controlDir: string): string[] {
	if (!existsSync(controlDir)) {
		return [];
	}

	return readdirSync(controlDir)
		.filter((fileName) => REQUEST_FILE_PATTERN.test(fileName))
		.sort()
		.map((fileName) => join(controlDir, fileName));
}

function extractRequestIdFromPath(requestPath: string): string | undefined {
	const fileName = basename(requestPath);
	const match = fileName.match(REQUEST_FILE_PATTERN);
	return match ? match[1] : undefined;
}

function inferLinkedProposalPaths(requestPath: string, proposalsDir: string): string[] {
	const linkedPaths = new Set<string>();

	const inferredId = extractRequestIdFromPath(requestPath);
	if (inferredId) {
		linkedPaths.add(join(proposalsDir, `${inferredId}.json`));
	}

	if (existsSync(requestPath)) {
		try {
			const parsed = JSON.parse(readFileSync(requestPath, "utf-8")) as { proposalPath?: unknown };
			if (typeof parsed.proposalPath === "string" && parsed.proposalPath.length > 0) {
				linkedPaths.add(parsed.proposalPath);
			}
		} catch {
			// Best-effort only: keep inferred path and continue.
		}
	}

	return [...linkedPaths];
}

function removeFileIfExists(pathValue: string): boolean {
	if (!existsSync(pathValue)) {
		return false;
	}

	unlinkSync(pathValue);
	return true;
}

function cleanupRequestsAndLinkedProposals(
	requestPaths: string[],
	proposalsDir: string,
): { removedRequestPaths: string[]; removedProposalPaths: string[] } {
	const linkedProposalPaths = new Set<string>();
	for (const requestPath of requestPaths) {
		for (const proposalPath of inferLinkedProposalPaths(requestPath, proposalsDir)) {
			linkedProposalPaths.add(proposalPath);
		}
	}

	const removedRequestPaths: string[] = [];
	for (const requestPath of requestPaths) {
		if (removeFileIfExists(requestPath)) {
			removedRequestPaths.push(requestPath);
		}
	}

	const removedProposalPaths: string[] = [];
	for (const proposalPath of linkedProposalPaths) {
		if (removeFileIfExists(proposalPath)) {
			removedProposalPaths.push(proposalPath);
		}
	}

	return {
		removedRequestPaths,
		removedProposalPaths,
	};
}

function buildFullReplaceUnifiedDiff(
	beforeContent: string,
	afterContent: string,
	beforeLabel: string,
	afterLabel: string,
): string {
	if (beforeContent === afterContent) {
		return [
			`--- ${beforeLabel}`,
			`+++ ${afterLabel}`,
			"@@ -1,0 +1,0 @@",
			"(no content changes)",
		].join("\n");
	}

	const beforeLines = beforeContent.length > 0 ? beforeContent.replace(/\n$/, "").split("\n") : [];
	const afterLines = afterContent.length > 0 ? afterContent.replace(/\n$/, "").split("\n") : [];

	return [
		`--- ${beforeLabel}`,
		`+++ ${afterLabel}`,
		`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
		...beforeLines.map((line) => `-${line}`),
		...afterLines.map((line) => `+${line}`),
	].join("\n");
}

export function parseApplyDecisionAnswer(answer: string): ApplyDecision | undefined {
	const normalized = answer.trim().toLowerCase();
	if (
		normalized === "y" ||
		normalized === "yes" ||
		normalized === "a" ||
		normalized === "apply"
	) {
		return "apply";
	}
	if (
		normalized === "n" ||
		normalized === "no" ||
		normalized === "r" ||
		normalized === "reject"
	) {
		return "reject";
	}
	return undefined;
}

async function defaultPromptDecision(inputValue: {
	request: FenceConfigApplyRequest;
	diff: string;
}): Promise<ApplyDecision> {
	const rl = createInterface({ input, output });
	try {
		while (true) {
			const answer = await rl.question(
				`Apply request ${inputValue.request.requestId} ` +
					`to ${inputValue.request.targetPath}? [y]es/[n]o: `,
			);
			const decision = parseApplyDecisionAnswer(answer);
			if (decision) {
				return decision;
			}
			output.write("Please answer yes/y or no/n.\n");
		}
	} finally {
		rl.close();
	}
}

export async function runPiFencedApply(inputValue: RunPiFencedApplyInput = {}): Promise<ApplyOutcome> {
	const paths = {
		...buildDefaultPaths(),
		...(inputValue.paths ?? {}),
	};

	const dependencies: ApplyWorkflowDependencies = {
		validateFenceConfig,
		promptDecision: defaultPromptDecision,
		print: (message) => output.write(`${message}\n`),
		warn: (message) => output.write(`pi-fenced-apply: ${message}\n`),
		...(inputValue.dependencies ?? {}),
	};

	mkdirSync(paths.controlDir, { recursive: true });
	mkdirSync(paths.proposalsDir, { recursive: true });
	mkdirSync(paths.backupsDir, { recursive: true });

	const requestPaths = listRequestPaths(paths.controlDir);
	if (requestPaths.length === 0) {
		return {
			type: "no-request",
			message: "No pending apply requests.",
		};
	}

	if (requestPaths.length > 1) {
		const cleanupResult = cleanupRequestsAndLinkedProposals(requestPaths, paths.proposalsDir);
		const message =
			`Detected ${requestPaths.length} pending requests. ` +
			`Dropped ${cleanupResult.removedRequestPaths.length} requests and ` +
			`${cleanupResult.removedProposalPaths.length} linked proposals.`;
		dependencies.warn(message);
		return {
			type: "conflict-cleanup",
			message,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	const requestPath = requestPaths[0];
	const inferredRequestId = extractRequestIdFromPath(requestPath);

	let request: FenceConfigApplyRequest;
	try {
		request = parseFenceConfigApplyRequest(readFileSync(requestPath, "utf-8"));
	} catch (error) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "invalid-request",
			requestId: inferredRequestId,
			message: `Invalid request file ${requestPath}: ${toErrorMessage(error)}`,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	try {
		assertGlobalTargetPolicy({
			request,
			env: inputValue.env,
			homeDir: inputValue.homeDir,
		});
	} catch (error) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "invalid-request",
			requestId: request.requestId,
			message: toErrorMessage(error),
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	let proposalContent: string;
	try {
		proposalContent = readFileSync(request.proposalPath, "utf-8");
	} catch (error) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "invalid-request",
			requestId: request.requestId,
			message: `Missing proposal file: ${toErrorMessage(error)}`,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	try {
		dependencies.validateFenceConfig(request.proposalPath);
	} catch (error) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "invalid-request",
			requestId: request.requestId,
			message: `Proposal validation failed: ${toErrorMessage(error)}`,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	const currentContent = existsSync(request.targetPath) ? readFileSync(request.targetPath, "utf-8") : "";
	const currentSha = sha256(currentContent);
	if (currentSha !== request.baseSha256) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "base-hash-mismatch",
			requestId: request.requestId,
			message:
				`Base hash mismatch for ${request.targetPath}. ` +
				`expected=${request.baseSha256} actual=${currentSha}`,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	const diff = buildFullReplaceUnifiedDiff(
		currentContent,
		proposalContent,
		`${request.targetPath} (current)`,
		`${request.proposalPath} (proposal)`,
	);
	dependencies.print(diff);

	const decision = await dependencies.promptDecision({ request, diff });
	if (decision === "reject") {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "rejected",
			requestId: request.requestId,
			message: `Request ${request.requestId} rejected by user.`,
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	try {
		applyReplaceWithRollback({
			targetPath: request.targetPath,
			proposalContent,
			requestId: request.requestId,
			backupsDir: paths.backupsDir,
			validateFenceConfig: dependencies.validateFenceConfig,
		});
	} catch (error) {
		const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
		return {
			type: "apply-failed",
			requestId: request.requestId,
			message: toErrorMessage(error),
			removedRequestPaths: cleanupResult.removedRequestPaths,
			removedProposalPaths: cleanupResult.removedProposalPaths,
		};
	}

	const cleanupResult = cleanupRequestsAndLinkedProposals([requestPath], paths.proposalsDir);
	return {
		type: "applied",
		requestId: request.requestId,
		message: `Applied request ${request.requestId}.`,
		removedRequestPaths: cleanupResult.removedRequestPaths,
		removedProposalPaths: cleanupResult.removedProposalPaths,
	};
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	if (!isAuthorizedApplyCaller(process.env)) {
		output.write(
			"pi-fenced-apply: direct invocation is disabled; " +
				"run pi-fenced instead.\n",
		);
		return 1;
	}

	if (argv.length > 0) {
		output.write(`pi-fenced-apply: unexpected arguments: ${argv.join(" ")}\n`);
		return 1;
	}

	const outcome = await runPiFencedApply({ env: process.env });
	output.write(`pi-fenced-apply: ${outcome.message}\n`);
	return isSuccessfulOutcome(outcome.type) ? 0 : 1;
}

function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
	if (!argv1) {
		return false;
	}
	return pathToFileURL(resolve(argv1)).href === metaUrl;
}

if (isMainModule(import.meta.url, process.argv[1])) {
	main().then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error) => {
			output.write(`pi-fenced-apply: ${toErrorMessage(error)}\n`);
			process.exitCode = 1;
		},
	);
}
