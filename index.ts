import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
	complete,
	validateToolArguments,
	type Message,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	applyExactEdits,
	buildEditProposalPreview,
	buildMutationProposalPrompt,
	buildScopeAnalysisPrompt,
	buildWriteProposalPreview,
	createMutationProposalTool,
	createScopeDecisionTool,
	ensureValidFenceConfigContent,
	toMutationProposal,
	toScopeAnalysis,
	type FenceConfigScope,
	type MutationProposalToolArguments,
	type ScopeDecisionToolArguments,
	type ScopeSource,
} from "./configure-fence.ts";

interface ScopePaths {
	sessionConfigPath: string;
	workspaceConfigPath: string;
	globalConfigPath: string;
}

interface FenceConfigChangeRequest {
	version: 1;
	requestId: string;
	createdAt: string;
	scope: FenceConfigScope;
	targetPath: string;
	proposalPath: string;
	mutationType: "replace";
	baseSha256: string;
	requestedBy: "pi-fenced-extension";
	summary: string;
}

const PI_FENCED_ROOT = "/tmp/pi-fenced";
const STRUCTURED_TOOL_ATTEMPTS = 3;

const CONFIGURE_SCOPE_SYSTEM_PROMPT =
	"You classify fence configuration scope. " +
	"Always call the provided tool exactly once.";
const CONFIGURE_MUTATION_SYSTEM_PROMPT =
	"You produce fence configuration mutations. " +
	"Always call the provided tool exactly once.";

const scopeDecisionTool = createScopeDecisionTool();
const mutationProposalTool = createMutationProposalTool();

function getScopePaths(ctx: ExtensionContext): ScopePaths {
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		sessionConfigPath: join(PI_FENCED_ROOT, "sessions", sessionId, "fence.json"),
		workspaceConfigPath: join(ctx.cwd, "fence.json"),
		globalConfigPath: join(homedir(), ".config", "fence", "fence.json"),
	};
}

function getTargetPathForScope(scope: FenceConfigScope, paths: ScopePaths): string {
	switch (scope) {
		case "session":
			return paths.sessionConfigPath;
		case "workspace":
			return paths.workspaceConfigPath;
		case "global":
			return paths.globalConfigPath;
	}
}

function formatScopeSource(source: ScopeSource): string {
	if (source === "llm") return "LLM decision";
	return "User selected after LLM unknown";
}

function createUserTextMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createToolErrorResult(toolCall: ToolCall, errorText: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: errorText }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	};
}

async function completeOutOfBandStructuredCall<TArgs>(
	ctx: ExtensionContext,
	options: {
		systemPrompt: string;
		userPrompt: string;
		tool: Tool<any>;
	},
): Promise<TArgs> {
	if (!ctx.model) {
		throw new Error("No model selected");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey && !auth.headers) {
		throw new Error(`No API credentials configured for ${ctx.model.provider}`);
	}

	const messages: Message[] = [createUserTextMessage(options.userPrompt)];

	for (let attempt = 1; attempt <= STRUCTURED_TOOL_ATTEMPTS; attempt += 1) {
		const response = await complete(
			ctx.model,
			{
				systemPrompt: options.systemPrompt,
				messages,
				tools: [options.tool],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);

		if (response.stopReason === "aborted") {
			throw new Error("configure-fence request was aborted");
		}
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "Model returned an error");
		}

		messages.push(response);

		const toolCalls = response.content.filter(
			(content): content is ToolCall => content.type === "toolCall",
		);
		if (toolCalls.length === 0) {
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model did not call required tool \"${options.tool.name}\" after ${STRUCTURED_TOOL_ATTEMPTS} attempts.`,
				);
			}
			messages.push(
				createUserTextMessage(`Call tool \"${options.tool.name}\" exactly once. Do not return prose.`),
			);
			continue;
		}

		if (toolCalls.length > 1) {
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model called ${toolCalls.length} tools, expected exactly one call to \"${options.tool.name}\".`,
				);
			}
			messages.push(
				createUserTextMessage(`Call tool \"${options.tool.name}\" exactly once in the next response.`),
			);
			continue;
		}

		const toolCall = toolCalls[0];
		if (toolCall.name !== options.tool.name) {
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model called unexpected tool \"${toolCall.name}\", expected \"${options.tool.name}\".`,
				);
			}
			messages.push(
				createToolErrorResult(
					toolCall,
					`Unexpected tool \"${toolCall.name}\". Call \"${options.tool.name}\" instead.`,
				),
			);
			continue;
		}

		try {
			const args = validateToolArguments(options.tool, toolCall) as TArgs;
			return args;
		} catch (error) {
			const errorText =
				error instanceof Error ? error.message : `Tool argument validation failed: ${String(error)}`;
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(`Model produced invalid arguments for \"${options.tool.name}\": ${errorText}`);
			}
			messages.push(createToolErrorResult(toolCall, errorText));
		}
	}

	throw new Error(`Failed to obtain structured output via tool \"${options.tool.name}\".`);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

function buildProposalPath(requestId: string): string {
	return join(PI_FENCED_ROOT, "proposals", `${requestId}.json`);
}

function buildRequestPath(requestId: string): string {
	return join(PI_FENCED_ROOT, "control", `request-${requestId}.json`);
}

function buildRequestEnvelope(input: {
	requestId: string;
	scope: FenceConfigScope;
	targetPath: string;
	proposalPath: string;
	existingContent?: string;
	summary: string;
}): FenceConfigChangeRequest {
	const baseContent = input.existingContent ?? "";
	return {
		version: 1,
		requestId: input.requestId,
		createdAt: new Date().toISOString(),
		scope: input.scope,
		targetPath: input.targetPath,
		proposalPath: input.proposalPath,
		mutationType: "replace",
		baseSha256: sha256(baseContent),
		requestedBy: "pi-fenced-extension",
		summary: input.summary,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("configure-fence", {
		description: "Guided out-of-band fence configuration proposal with external apply handoff",
		handler: async (args, ctx) => {
			let requestText = args.trim();
			if (requestText.length === 0) {
				requestText =
					(await ctx.ui.input(
						"Configure fence",
						"Describe how the fence config should change",
					)) ?? "";
			}

			requestText = requestText.trim();
			if (requestText.length === 0) {
				ctx.ui.notify("configure-fence cancelled: no change request provided", "info");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected for /configure-fence", "error");
				return;
			}

			const scopePaths = getScopePaths(ctx);

			try {
				ctx.ui.notify("/configure-fence: analyzing scope...", "info");
				const scopePrompt = buildScopeAnalysisPrompt({
					requestText,
					sessionConfigPath: scopePaths.sessionConfigPath,
					workspaceConfigPath: scopePaths.workspaceConfigPath,
					globalConfigPath: scopePaths.globalConfigPath,
				});
				const scopeArgs = await completeOutOfBandStructuredCall<ScopeDecisionToolArguments>(ctx, {
					systemPrompt: CONFIGURE_SCOPE_SYSTEM_PROMPT,
					userPrompt: scopePrompt,
					tool: scopeDecisionTool,
				});
				const scopeAnalysis = toScopeAnalysis(scopeArgs);

				let resolvedScope: FenceConfigScope;
				let scopeSource: ScopeSource;
				if (scopeAnalysis.scopeDecision === "unknown") {
					const scopeSelection = await ctx.ui.select(
						"LLM scope decision is unknown. Apply change to:",
						[
							"session (/tmp/pi-fenced/sessions/<session-id>/fence.json)",
							"workspace (./fence.json)",
							"global (~/.config/fence/fence.json)",
						],
					);
					if (!scopeSelection) {
						ctx.ui.notify("/configure-fence cancelled", "info");
						return;
					}
					if (scopeSelection.startsWith("session")) {
						resolvedScope = "session";
					} else if (scopeSelection.startsWith("workspace")) {
						resolvedScope = "workspace";
					} else {
						resolvedScope = "global";
					}
					scopeSource = "user-after-unknown";
				} else {
					resolvedScope = scopeAnalysis.scopeDecision;
					scopeSource = "llm";
				}

				const targetPath = getTargetPathForScope(resolvedScope, scopePaths);
				const existingContent = existsSync(targetPath)
					? readFileSync(targetPath, "utf-8")
					: undefined;

				ctx.ui.notify("/configure-fence: generating mutation proposal...", "info");
				const mutationPrompt = buildMutationProposalPrompt({
					requestText,
					resolvedScope,
					targetPath,
					scopeReasoning: scopeAnalysis.reasoning,
					scopeEffectSummary: scopeAnalysis.effectSummary,
					scopeConflictSummary: scopeAnalysis.conflictSummary,
					existingContent,
				});
				const mutationArgs = await completeOutOfBandStructuredCall<MutationProposalToolArguments>(
					ctx,
					{
						systemPrompt: CONFIGURE_MUTATION_SYSTEM_PROMPT,
						userPrompt: mutationPrompt,
						tool: mutationProposalTool,
					},
				);
				const mutation = toMutationProposal(mutationArgs);

				let finalContent: string;
				let preview: string;
				if (mutation.mutationType === "write") {
					finalContent = ensureValidFenceConfigContent(mutation.writeContent);
					preview = buildWriteProposalPreview(targetPath, mutation.writeContent);
				} else {
					if (existingContent === undefined) {
						throw new Error(
							"LLM proposed edit for a missing config file. Retry and force mutationType=write.",
						);
					}
					const editedContent = applyExactEdits(existingContent, mutation.edits);
					finalContent = ensureValidFenceConfigContent(editedContent);
					preview = buildEditProposalPreview(targetPath, mutation.edits);
				}

				const allowChange = await ctx.ui.confirm(
					"Queue external fence configuration change?",
					`${preview}\n\n` +
						`Resolved scope: ${resolvedScope}\n` +
						`Scope source: ${formatScopeSource(scopeSource)}\n` +
						`LLM scope decision: ${scopeAnalysis.scopeDecision}\n` +
						`Scope reasoning: ${scopeAnalysis.reasoning}\n` +
						`Target path: ${targetPath}\n` +
						`Mutation type: ${mutation.mutationType}\n` +
						`Mutation intent: ${mutation.changeMode}\n` +
						`Effect summary: ${mutation.effectSummary}\n` +
						`Conflict summary: ${mutation.conflictSummary}\n\n` +
						"This will write a proposal + request under /tmp/pi-fenced and hand off to external apply.",
				);
				if (!allowChange) {
					ctx.ui.notify("/configure-fence cancelled by user", "warning");
					return;
				}

				const requestId = randomUUID();
				const proposalPath = buildProposalPath(requestId);
				const requestPath = buildRequestPath(requestId);
				const requestEnvelope = buildRequestEnvelope({
					requestId,
					scope: resolvedScope,
					targetPath,
					proposalPath,
					existingContent,
					summary: mutation.effectSummary,
				});

				mkdirSync(dirname(proposalPath), { recursive: true });
				writeFileSync(proposalPath, finalContent, "utf-8");

				mkdirSync(dirname(requestPath), { recursive: true });
				writeFileSync(requestPath, `${JSON.stringify(requestEnvelope, null, "  ")}\n`, "utf-8");

				ctx.ui.notify(
					`Fence config proposal queued: ${requestPath}\nProposal: ${proposalPath}`,
					"info",
				);

				const shouldShutdown = await ctx.ui.confirm(
					"Restart now for external apply?",
					"Shutdown PI now so the outside launcher can run apply/reject flow and restart.",
				);
				if (shouldShutdown) {
					ctx.ui.notify("Shutting down PI for external fence apply handoff...", "warning");
					ctx.shutdown();
				}
			} catch (error) {
				ctx.ui.notify(
					`/configure-fence failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
