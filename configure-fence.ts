import { resolve } from "node:path";
import type { Tool } from "@mariozechner/pi-ai";

export type FenceConfigScope = "session" | "workspace" | "global";
export type LlmScopeDecision = FenceConfigScope | "unknown";
export type ScopeSource = "llm" | "user-after-unknown";

export interface ScopeAnalysisPromptInput {
	requestText: string;
	sessionConfigPath: string;
	workspaceConfigPath: string;
	globalConfigPath: string;
}

export interface MutationProposalPromptInput {
	requestText: string;
	resolvedScope: FenceConfigScope;
	targetPath: string;
	scopeReasoning: string;
	scopeEffectSummary: string;
	scopeConflictSummary: string;
	existingContent?: string;
}

export interface ScopeAnalysis {
	scopeDecision: LlmScopeDecision;
	reasoning: string;
	changeMode: string;
	effectSummary: string;
	conflictSummary: string;
}

interface BaseMutationProposal {
	reasoning: string;
	changeMode: string;
	effectSummary: string;
	conflictSummary: string;
}

export interface WriteMutationProposal extends BaseMutationProposal {
	mutationType: "write";
	writeContent: string;
}

export interface EditMutationProposal extends BaseMutationProposal {
	mutationType: "edit";
	edits: Array<{ oldText: string; newText: string }>;
}

export type MutationProposal = WriteMutationProposal | EditMutationProposal;

export interface ScopeDecisionToolArguments {
	scopeDecision: LlmScopeDecision | string;
	reasoning: string;
	changeMode: string;
	effectSummary: string;
	conflictSummary?: string;
}

export interface MutationProposalToolArguments {
	mutationType: "write" | "edit" | string;
	reasoning: string;
	changeMode: string;
	effectSummary: string;
	conflictSummary?: string;
	writeContent?: string;
	edits?: Array<{ oldText: string; newText: string }>;
}

export const SCOPE_DECISION_TOOL_NAME = "configure_fence_scope_decision";
export const MUTATION_PROPOSAL_TOOL_NAME = "configure_fence_mutation_proposal";

const DEFAULT_PREVIEW_CHARS = 1200;

export function createScopeDecisionTool(): Tool<any> {
	return {
		name: SCOPE_DECISION_TOOL_NAME,
		description:
			"Decide whether fence config should be session/workspace/global/unknown and summarize effect/conflicts.",
		parameters: {
			type: "object",
			properties: {
				scopeDecision: {
					type: "string",
					enum: ["session", "workspace", "global", "unknown"],
				},
				reasoning: { type: "string", minLength: 1 },
				changeMode: { type: "string", minLength: 1 },
				effectSummary: { type: "string", minLength: 1 },
				conflictSummary: { type: "string" },
			},
			required: ["scopeDecision", "reasoning", "changeMode", "effectSummary"],
			additionalProperties: false,
		},
	};
}

export function createMutationProposalTool(): Tool<any> {
	return {
		name: MUTATION_PROPOSAL_TOOL_NAME,
		description:
			"Propose exact fence config mutation as write content or edit blocks with effect/conflict summaries.",
		parameters: {
			type: "object",
			properties: {
				mutationType: {
					type: "string",
					enum: ["write", "edit"],
				},
				reasoning: { type: "string", minLength: 1 },
				changeMode: { type: "string", minLength: 1 },
				effectSummary: { type: "string", minLength: 1 },
				conflictSummary: { type: "string" },
				writeContent: { type: "string" },
				edits: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							oldText: { type: "string", minLength: 1 },
							newText: { type: "string" },
						},
						required: ["oldText", "newText"],
						additionalProperties: false,
					},
				},
			},
			required: ["mutationType", "reasoning", "changeMode", "effectSummary"],
			additionalProperties: false,
			allOf: [
				{
					if: {
						properties: {
							mutationType: { const: "write" },
						},
					},
					then: {
						required: ["writeContent"],
					},
				},
				{
					if: {
						properties: {
							mutationType: { const: "edit" },
						},
					},
					then: {
						required: ["edits"],
					},
				},
			],
		},
	};
}

export function normalizeScopeDecision(value: string): LlmScopeDecision | undefined {
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "session" ||
		normalized === "workspace" ||
		normalized === "global" ||
		normalized === "unknown"
	) {
		return normalized;
	}
	return undefined;
}

export function toScopeAnalysis(args: ScopeDecisionToolArguments): ScopeAnalysis {
	const scopeDecision = normalizeScopeDecision(String(args.scopeDecision ?? ""));
	if (!scopeDecision) {
		throw new Error("Invalid scopeDecision. Expected session, workspace, global, or unknown.");
	}
	return {
		scopeDecision,
		reasoning: requireNonEmptyString(args.reasoning, "reasoning"),
		changeMode: requireNonEmptyString(args.changeMode, "changeMode"),
		effectSummary: requireNonEmptyString(args.effectSummary, "effectSummary"),
		conflictSummary: optionalString(args.conflictSummary) ?? "none",
	};
}

export function toMutationProposal(args: MutationProposalToolArguments): MutationProposal {
	const mutationType = String(args.mutationType ?? "").trim().toLowerCase();
	const common = {
		reasoning: requireNonEmptyString(args.reasoning, "reasoning"),
		changeMode: requireNonEmptyString(args.changeMode, "changeMode"),
		effectSummary: requireNonEmptyString(args.effectSummary, "effectSummary"),
		conflictSummary: optionalString(args.conflictSummary) ?? "none",
	};

	if (mutationType === "write") {
		return {
			mutationType: "write",
			writeContent: requireNonEmptyString(args.writeContent, "writeContent"),
			...common,
		};
	}

	if (mutationType === "edit") {
		if (!Array.isArray(args.edits) || args.edits.length === 0) {
			throw new Error("Invalid edits: expected non-empty edits array.");
		}

		const edits = args.edits.map((edit, index) => {
			if (typeof edit !== "object" || edit === null) {
				throw new Error(`Invalid edits[${index}]: expected object.`);
			}
			return {
				oldText: requireNonEmptyString(
					(edit as { oldText?: unknown }).oldText,
					`edits[${index}].oldText`,
				),
				newText: requireString((edit as { newText?: unknown }).newText, `edits[${index}].newText`),
			};
		});

		return {
			mutationType: "edit",
			edits,
			...common,
		};
	}

	throw new Error("Invalid mutationType. Expected write or edit.");
}

export function buildScopeAnalysisPrompt(input: ScopeAnalysisPromptInput): string {
	return [
		"Determine where a fence configuration change should apply.",
		"Call the provided tool exactly once with your decision.",
		"Do not output prose.",
		"",
		"User request:",
		input.requestText,
		"",
		"Available target files:",
		`- session: ${input.sessionConfigPath}`,
		`- workspace: ${input.workspaceConfigPath}`,
		`- global: ${input.globalConfigPath}`,
		"",
		"Scope precedence (no merge):",
		"- session config completely overrides workspace/global.",
		"- workspace config completely overrides global.",
		"- exactly one scope file is active.",
		"",
		"When ambiguous, set scopeDecision to unknown.",
	].join("\n");
}

export function buildMutationProposalPrompt(input: MutationProposalPromptInput): string {
	const existingSection =
		input.existingContent !== undefined
			? [
				"Current target file content:",
				"```json",
				input.existingContent,
				"```",
			].join("\n")
			: "Target file does not exist yet.";

	return [
		"Propose the exact fence configuration mutation.",
		"Call the provided tool exactly once.",
		"Do not output prose.",
		"",
		`Resolved scope: ${input.resolvedScope}`,
		`Target file path: ${input.targetPath}`,
		"",
		"User request:",
		input.requestText,
		"",
		"Scope analysis from previous step:",
		`- reasoning: ${input.scopeReasoning}`,
		`- expected effect: ${input.scopeEffectSummary}`,
		`- conflict summary: ${input.scopeConflictSummary}`,
		"",
		existingSection,
		"",
		"Mutation semantics:",
		"- Preserve unrelated settings.",
		"- Keep JSON valid (no comments, no trailing commas).",
		"- Do not include top-level extends (no merge policy).",
		"- Use write for create/full rewrite, edit for minimal exact patch.",
	].join("\n");
}

export function isTargetConfigPath(pathValue: string, cwd: string, targetPath: string): boolean {
	return resolve(cwd, pathValue) === resolve(targetPath);
}

export function buildWriteProposalPreview(pathValue: string, content: string): string {
	return [
		`Tool proposal: write ${pathValue}`,
		"",
		"Proposed file content:",
		truncateForPreview(content, DEFAULT_PREVIEW_CHARS),
	].join("\n");
}

export function buildEditProposalPreview(
	pathValue: string,
	edits: Array<{ oldText: string; newText: string }>,
): string {
	const editBlocks = edits
		.map((edit, index) => {
			const oldText = truncateForPreview(edit.oldText, 260);
			const newText = truncateForPreview(edit.newText, 260);
			return [`Edit #${index + 1}`, `- oldText: ${oldText}`, `- newText: ${newText}`].join("\n");
		})
		.join("\n\n");

	return [
		`Tool proposal: edit ${pathValue}`,
		"",
		`Proposed edit blocks: ${edits.length}`,
		truncateForPreview(editBlocks, DEFAULT_PREVIEW_CHARS),
	].join("\n");
}

export function applyExactEdits(
	originalContent: string,
	edits: Array<{ oldText: string; newText: string }>,
): string {
	const matches = edits.map((edit, index) => {
		let occurrenceCount = 0;
		let matchIndex = -1;
		let searchOffset = 0;
		while (true) {
			const nextIndex = originalContent.indexOf(edit.oldText, searchOffset);
			if (nextIndex === -1) break;
			occurrenceCount += 1;
			if (occurrenceCount === 1) {
				matchIndex = nextIndex;
			}
			searchOffset = nextIndex + edit.oldText.length;
		}

		if (occurrenceCount === 0) {
			throw new Error(`Edit #${index + 1}: oldText not found in original content.`);
		}
		if (occurrenceCount > 1) {
			throw new Error(
				`Edit #${index + 1}: oldText matched ${occurrenceCount} times; expected unique match.`,
			);
		}

		return {
			index,
			start: matchIndex,
			end: matchIndex + edit.oldText.length,
			replacement: edit.newText,
		};
	});

	const sorted = [...matches].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i += 1) {
		if (sorted[i].start < sorted[i - 1].end) {
			throw new Error(
				`Edit #${sorted[i].index + 1} overlaps with edit #${sorted[i - 1].index + 1}.`,
			);
		}
	}

	let updatedContent = originalContent;
	const descending = [...matches].sort((a, b) => b.start - a.start);
	for (const match of descending) {
		updatedContent =
			updatedContent.slice(0, match.start) +
			match.replacement +
			updatedContent.slice(match.end);
	}

	return updatedContent;
}

export function ensureValidFenceConfigContent(content: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Proposed fence config content is not valid JSON: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Fence config must be a JSON object.");
	}

	if (Object.prototype.hasOwnProperty.call(parsed, "extends")) {
		throw new Error(
			"Top-level \"extends\" is not allowed in active config scope (no-merge policy).",
		);
	}

	return content.endsWith("\n") ? content : `${content}\n`;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Missing or invalid string field: ${fieldName}`);
	}
	return value.trim();
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new Error(`Missing or invalid string field: ${fieldName}`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error("Invalid optional string field");
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function truncateForPreview(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const clipped = value.slice(0, maxChars);
	return `${clipped}\n... [truncated ${value.length - maxChars} chars]`;
}
