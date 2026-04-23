import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	buildWriteProposalPreview,
	createMutationProposalTool,
	ensureValidFenceConfigContent,
	toMutationProposal,
	type MutationProposalToolArguments,
} from "./configure-fence.ts";
import { resolveFencePaths } from "./launcher/path-resolution.ts";

interface FenceConfigChangeRequest {
	version: 1;
	requestId: string;
	createdAt: string;
	scope: "global";
	targetPath: string;
	proposalPath: string;
	mutationType: "replace";
	baseSha256: string;
	requestedBy: "pi-fenced-extension";
	summary: string;
}

export interface MutationPromptInput {
	requestText: string;
	targetPath: string;
	existingContent?: string;
}

export const PI_FENCED_ROOT = "/tmp/pi-fenced";
const STRUCTURED_TOOL_ATTEMPTS = 3;
const UNMANAGED_RUNTIME_WARNING =
	"pi-fenced extension requires launcher-managed runtime. " +
	"Run PI via pi-fenced. Shutting down.";

const MUTATION_SYSTEM_PROMPT_TEMPLATE_URL = new URL(
	"./prompts/configure-fence/mutation-system.prompt.txt",
	import.meta.url,
);
const MUTATION_PROMPT_TEMPLATE_URL = new URL(
	"./prompts/configure-fence/mutation-proposal.prompt.txt",
	import.meta.url,
);
const FENCE_CONFIGURATION_REFERENCE_PROMPT_URL = new URL(
	"./prompts/configure-fence/fence-configuration-reference.prompt.txt",
	import.meta.url,
);

const mutationProposalTool = createMutationProposalTool();
let mutationSystemPromptCache: string | undefined;
let mutationPromptTemplateCache: string | undefined;
let fenceConfigurationReferencePromptCache: string | undefined;

export function isLauncherManagedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_FENCED_LAUNCHER === "1";
}

export function resolveGlobalConfigTargetPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolveFencePaths({ env }).globalConfigPath;
}

export function composeShowFenceConfigOutput(stderr: string, stdout: string): string {
	return `${stderr}${stdout}`;
}

export function composeInvalidConfigureFenceFeedback(invalidReason: string): string {
	return (
		"/configure-fence request is not actionable: " +
			`${invalidReason}\n` +
			"Please describe a concrete Fence policy change " +
			"(what to allow/deny and expected effect)."
	);
}

export function buildGlobalRequestEnvelope(input: {
	requestId: string;
	targetPath: string;
	proposalPath: string;
	existingContent?: string;
	summary: string;
	createdAt?: string;
}): FenceConfigChangeRequest {
	const baseContent = input.existingContent ?? "";
	return {
		version: 1,
		requestId: input.requestId,
		createdAt: input.createdAt ?? new Date().toISOString(),
		scope: "global",
		targetPath: input.targetPath,
		proposalPath: input.proposalPath,
		mutationType: "replace",
		baseSha256: sha256(baseContent),
		requestedBy: "pi-fenced-extension",
		summary: input.summary,
	};
}

function getMutationSystemPromptTemplate(): string {
	if (mutationSystemPromptCache !== undefined) {
		return mutationSystemPromptCache;
	}
	mutationSystemPromptCache = readFileSync(MUTATION_SYSTEM_PROMPT_TEMPLATE_URL, "utf-8");
	return mutationSystemPromptCache;
}

function getMutationPromptTemplate(): string {
	if (mutationPromptTemplateCache !== undefined) {
		return mutationPromptTemplateCache;
	}
	mutationPromptTemplateCache = readFileSync(MUTATION_PROMPT_TEMPLATE_URL, "utf-8");
	return mutationPromptTemplateCache;
}

function getFenceConfigurationReferencePrompt(): string {
	if (fenceConfigurationReferencePromptCache !== undefined) {
		return fenceConfigurationReferencePromptCache;
	}
	fenceConfigurationReferencePromptCache = readFileSync(
		FENCE_CONFIGURATION_REFERENCE_PROMPT_URL,
		"utf-8",
	);
	return fenceConfigurationReferencePromptCache;
}

function applyTemplateReplacements(
	template: string,
	replacements: Record<string, string>,
): string {
	let rendered = template;
	for (const [key, value] of Object.entries(replacements)) {
		rendered = rendered.replaceAll(`%%${key}%%`, value);
	}
	return rendered;
}

function buildExistingTargetContext(existingContent: string | undefined): string {
	if (existingContent === undefined) {
		return "Target file does not exist.";
	}

	return ["```json", existingContent, "```"].join("\n");
}

export function buildMutationSystemPrompt(): string {
	return applyTemplateReplacements(getMutationSystemPromptTemplate(), {
		FENCE_CONFIGURATION_REFERENCE: getFenceConfigurationReferencePrompt(),
	});
}

export function buildMutationPrompt(input: MutationPromptInput): string {
	const template = getMutationPromptTemplate();
	return applyTemplateReplacements(template, {
		TOOL_NAME: mutationProposalTool.name,
		RESOLVED_SCOPE: "global",
		TARGET_PATH: input.targetPath,
		REQUEST_TEXT: input.requestText,
		SCOPE_REASONING:
			"Global-only v1 mode: /configure-fence always targets the PI global config file.",
		SCOPE_EFFECT_SUMMARY:
			"Requested change applies to launcher-managed PI sessions through the global config.",
		SCOPE_CONFLICT_SUMMARY: "none",
		EXISTING_TARGET_CONTEXT: buildExistingTargetContext(input.existingContent),
	});
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
					`Model did not call required tool "${options.tool.name}" ` +
						`after ${STRUCTURED_TOOL_ATTEMPTS} attempts.`,
				);
			}
			messages.push(
				createUserTextMessage(`Call tool "${options.tool.name}" exactly once. Do not return prose.`),
			);
			continue;
		}

		if (toolCalls.length > 1) {
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model called ${toolCalls.length} tools, expected exactly one ` +
						`call to "${options.tool.name}".`,
				);
			}
			messages.push(
				createUserTextMessage(
					`Call tool "${options.tool.name}" exactly once in the next response.`,
				),
			);
			continue;
		}

		const toolCall = toolCalls[0];
		if (toolCall.name !== options.tool.name) {
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model called unexpected tool "${toolCall.name}", expected ` +
						`"${options.tool.name}".`,
				);
			}
			messages.push(
				createToolErrorResult(
					toolCall,
					`Unexpected tool "${toolCall.name}". ` +
						`Call "${options.tool.name}" instead.`,
				),
			);
			continue;
		}

		try {
			const args = validateToolArguments(options.tool, toolCall) as TArgs;
			return args;
		} catch (error) {
			const errorText =
				error instanceof Error
					? error.message
					: `Tool argument validation failed: ${String(error)}`;
			if (attempt === STRUCTURED_TOOL_ATTEMPTS) {
				throw new Error(
					`Model produced invalid arguments for "${options.tool.name}": ${errorText}`,
				);
			}
			messages.push(createToolErrorResult(toolCall, errorText));
		}
	}

	throw new Error(`Failed to obtain structured output via tool "${options.tool.name}".`);
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warnAndShutdownForUnmanagedRuntime(ctx: ExtensionContext): void {
	ctx.ui.notify(UNMANAGED_RUNTIME_WARNING, "warning");
	ctx.shutdown();
}

function toNormalizedLines(content: string): string[] {
	return content.replace(/\r\n?/g, "\n").split("\n");
}

async function showReadOnlyFenceConfigOutput(
	ctx: ExtensionContext,
	title: string,
	content: string,
): Promise<void> {
	const lines = toNormalizedLines(content.length > 0 ? content : "(no output)\n");

	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		let firstVisibleLine = 0;

		const getViewportLineCount = (): number => Math.max(4, tui.terminal.rows - 8);
		const getMaxFirstVisibleLine = (): number =>
			Math.max(0, lines.length - getViewportLineCount());
		const clampFirstVisibleLine = (): void => {
			firstVisibleLine = Math.min(Math.max(firstVisibleLine, 0), getMaxFirstVisibleLine());
		};

		return {
			render: (_width: number): string[] => {
				clampFirstVisibleLine();
				const viewportLineCount = getViewportLineCount();
				const visibleLines = lines.slice(
					firstVisibleLine,
					firstVisibleLine + viewportLineCount,
				);
				const startLine = lines.length === 0 ? 0 : firstVisibleLine + 1;
				const endLine =
					lines.length === 0
						? 0
						: Math.min(firstVisibleLine + viewportLineCount, lines.length);

				return [
					theme.fg("accent", theme.bold(`${title} (read-only)`)),
					theme.fg(
						"warning",
						"READ-ONLY: edits here are ignored. Use /configure-fence to change configuration.",
					),
					theme.fg("dim", `Lines ${startLine}-${endLine} of ${lines.length}`),
					...visibleLines,
					"",
					theme.fg("dim", "Esc/Enter close · ↑/↓ scroll · PgUp/PgDn · Home/End"),
				];
			},
			invalidate: () => {},
			handleInput: (data: string): void => {
				if (
					keybindings.matches(data, "tui.select.cancel") ||
					keybindings.matches(data, "tui.select.confirm")
				) {
					done(undefined);
					return;
				}

				const maxFirstVisibleLine = getMaxFirstVisibleLine();
				if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
					firstVisibleLine = 0;
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
					firstVisibleLine = maxFirstVisibleLine;
					tui.requestRender();
					return;
				}

				const pageSize = Math.max(1, getViewportLineCount() - 1);
				let nextFirstVisibleLine = firstVisibleLine;
				if (keybindings.matches(data, "tui.select.up")) {
					nextFirstVisibleLine -= 1;
				} else if (keybindings.matches(data, "tui.select.down")) {
					nextFirstVisibleLine += 1;
				} else if (keybindings.matches(data, "tui.select.pageUp")) {
					nextFirstVisibleLine -= pageSize;
				} else if (keybindings.matches(data, "tui.select.pageDown")) {
					nextFirstVisibleLine += pageSize;
				} else {
					return;
				}

				firstVisibleLine = Math.min(Math.max(nextFirstVisibleLine, 0), maxFirstVisibleLine);
				tui.requestRender();
			},
		};
	});
}

export function registerPiFencedExtension(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!isLauncherManagedRuntime(env)) {
		pi.on("session_start", (_event, ctx) => {
			warnAndShutdownForUnmanagedRuntime(ctx);
		});
		return;
	}

	pi.on("session_start", (_event, ctx) => {
		const runtimeMode = env.FENCE_SANDBOX === "1" ? "🔒 fence" : "yolo";
		ctx.ui.setStatus("pi-fenced", runtimeMode);
	});

	pi.registerCommand("configure-fence", {
		description: "Guided out-of-band fence configuration proposal with external apply handoff",
		handler: async (args, ctx) => {
			if (!isLauncherManagedRuntime(env)) {
				warnAndShutdownForUnmanagedRuntime(ctx);
				return;
			}

			const requestText = args.trim();
			if (requestText.length === 0) {
				ctx.ui.notify(
					"No change request provided.\n" +
						"Usage: /configure-fence <change request>\n" +
						"Example: /configure-fence allow api.example.com for outbound HTTPS",
					"info",
				);
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected for /configure-fence", "error");
				return;
			}

			const targetPath = resolveGlobalConfigTargetPath(env);
			const existingContent = existsSync(targetPath)
				? readFileSync(targetPath, "utf-8")
				: undefined;

			try {
				ctx.ui.notify("/configure-fence: generating mutation proposal...", "info");
				const mutationPrompt = buildMutationPrompt({
					requestText,
					targetPath,
					existingContent,
				});
				const mutationArgs = await completeOutOfBandStructuredCall<MutationProposalToolArguments>(
					ctx,
					{
						systemPrompt: buildMutationSystemPrompt(),
						userPrompt: mutationPrompt,
						tool: mutationProposalTool,
					},
				);
				const mutation = toMutationProposal(mutationArgs);
				if (mutation.requestValidity === "invalid") {
					ctx.ui.notify(
						composeInvalidConfigureFenceFeedback(mutation.invalidReason),
						"warning",
					);
					return;
				}

				let finalContent: string;
				let preview: string;
				if (mutation.mutationType === "write") {
					finalContent = ensureValidFenceConfigContent(mutation.writeContent);
					preview = buildWriteProposalPreview(targetPath, mutation.writeContent);
				} else {
					if (existingContent === undefined) {
						throw new Error(
							"LLM proposed edit for a missing config file. " +
								"Retry and force mutationType=write.",
						);
					}
					const editedContent = applyExactEdits(existingContent, mutation.edits);
					finalContent = ensureValidFenceConfigContent(editedContent);
					preview = buildEditProposalPreview(targetPath, mutation.edits);
				}

				const allowChange = await ctx.ui.confirm(
					"Queue external fence configuration change?",
					`${preview}\n\n` +
						`Resolved scope: global (fixed in v1)\n` +
						`Target path: ${targetPath}\n` +
						`Mutation type: ${mutation.mutationType}\n` +
						`Mutation intent: ${mutation.changeMode}\n` +
						`Effect summary: ${mutation.effectSummary}\n` +
						`Conflict summary: ${mutation.conflictSummary}\n\n` +
						"This will write a proposal + request under /tmp/pi-fenced " +
						"and hand off to external apply.",
				);
				if (!allowChange) {
					ctx.ui.notify("/configure-fence cancelled by user", "warning");
					return;
				}

				const requestId = randomUUID();
				const proposalPath = buildProposalPath(requestId);
				const requestPath = buildRequestPath(requestId);
				const requestEnvelope = buildGlobalRequestEnvelope({
					requestId,
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
					ctx.ui.notify(
						"Shutting down PI for external fence apply handoff...",
						"warning",
					);
					ctx.shutdown();
				}
			} catch (error) {
				ctx.ui.notify(`/configure-fence failed: ${toErrorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("show-fence-config", {
		description:
			"Show effective Fence config for the PI global target using fence config show",
		handler: async (_args, ctx) => {
			if (!isLauncherManagedRuntime(env)) {
				warnAndShutdownForUnmanagedRuntime(ctx);
				return;
			}

			const targetPath = resolveGlobalConfigTargetPath(env);
			try {
				const result = await pi.exec(
					"fence",
					["config", "show", "--settings", targetPath],
					{ cwd: ctx.cwd, signal: ctx.signal },
				);

				const outputText = composeShowFenceConfigOutput(result.stderr, result.stdout);
				await showReadOnlyFenceConfigOutput(ctx, "/show-fence-config", outputText);

				if (result.killed || result.code !== 0) {
					ctx.ui.notify(
						`/show-fence-config exited with code ${result.code}` +
							(result.killed ? " (killed)" : ""),
						"warning",
					);
				}
			} catch (error) {
				ctx.ui.notify(`/show-fence-config failed: ${toErrorMessage(error)}`, "error");
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerPiFencedExtension(pi);
}
