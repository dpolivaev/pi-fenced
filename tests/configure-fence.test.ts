import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments, type ToolCall } from "@mariozechner/pi-ai";
import {
	applyExactEdits,
	buildEditProposalPreview,
	buildMutationProposalPrompt,
	buildScopeAnalysisPrompt,
	buildWriteProposalPreview,
	createMutationProposalTool,
	createScopeDecisionTool,
	ensureValidFenceConfigContent,
	isTargetConfigPath,
	normalizeScopeDecision,
	toMutationProposal,
	toScopeAnalysis,
} from "../configure-fence.ts";

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
	return {
		type: "toolCall",
		id: "tool-call-1",
		name,
		arguments: args,
	};
}

test("normalizeScopeDecision accepts session/workspace/global/unknown", () => {
	assert.equal(normalizeScopeDecision("session"), "session");
	assert.equal(normalizeScopeDecision(" WORKSPACE "), "workspace");
	assert.equal(normalizeScopeDecision("global"), "global");
	assert.equal(normalizeScopeDecision("unknown"), "unknown");
});

test("normalizeScopeDecision rejects invalid values", () => {
	assert.equal(normalizeScopeDecision("project"), undefined);
	assert.equal(normalizeScopeDecision(""), undefined);
});

test("buildScopeAnalysisPrompt includes no-merge precedence", () => {
	const prompt = buildScopeAnalysisPrompt({
		requestText: "allow github.com",
		sessionConfigPath: "/tmp/pi-fenced/sessions/abc/fence.json",
		workspaceConfigPath: "/workspace/app/fence.json",
		globalConfigPath: "/Users/test/.config/fence/fence.json",
	});

	assert.match(prompt, /Call the provided tool exactly once/);
	assert.match(prompt, /allow github\.com/);
	assert.match(prompt, /session: \/tmp\/pi-fenced\/sessions\/abc\/fence\.json/);
	assert.match(prompt, /workspace: \/workspace\/app\/fence\.json/);
	assert.match(prompt, /global: \/Users\/test\/.config\/fence\/fence\.json/);
	assert.match(prompt, /exactly one scope file is active/);
});

test("buildMutationProposalPrompt documents extends support", () => {
	const prompt = buildMutationProposalPrompt({
		requestText: "deny git push",
		resolvedScope: "workspace",
		targetPath: "/workspace/app/fence.json",
		scopeReasoning: "repo specific",
		scopeEffectSummary: "restrict push",
		scopeConflictSummary: "none",
		existingContent: '{"command":{"deny":[]}}',
	});

	assert.match(prompt, /Call the provided tool exactly once/);
	assert.match(prompt, /Resolved scope: workspace/);
	assert.match(prompt, /Current target file content:/);
	assert.match(prompt, /Top-level extends values are allowed when needed/);
});

test("scope tool schema validates correct arguments", () => {
	const tool = createScopeDecisionTool();
	const validated = validateToolArguments(
		tool,
		makeToolCall(tool.name, {
			scopeDecision: "session",
			reasoning: "temporary",
			changeMode: "append-array-value",
			effectSummary: "add one deny command",
			conflictSummary: "none",
		}),
	) as Record<string, unknown>;

	assert.equal(validated.scopeDecision, "session");
	assert.equal(validated.changeMode, "append-array-value");
});

test("scope tool schema rejects invalid scopeDecision", () => {
	const tool = createScopeDecisionTool();
	assert.throws(
		() =>
			validateToolArguments(
				tool,
				makeToolCall(tool.name, {
					scopeDecision: "team",
					reasoning: "x",
					changeMode: "x",
					effectSummary: "x",
				}),
			),
		/Validation failed/,
	);
});

test("toScopeAnalysis normalizes optional conflict summary", () => {
	const parsed = toScopeAnalysis({
		scopeDecision: "global",
		reasoning: "shared",
		changeMode: "set-scalar",
		effectSummary: "enable localhost",
	});
	assert.equal(parsed.scopeDecision, "global");
	assert.equal(parsed.conflictSummary, "none");
});

test("toScopeAnalysis rejects invalid scopeDecision", () => {
	assert.throws(
		() =>
			toScopeAnalysis({
				scopeDecision: "team",
				reasoning: "x",
				changeMode: "x",
				effectSummary: "x",
			}),
		/Invalid scopeDecision/,
	);
});

test("mutation tool schema validates write arguments", () => {
	const tool = createMutationProposalTool();
	const validated = validateToolArguments(
		tool,
		makeToolCall(tool.name, {
			mutationType: "write",
			reasoning: "create file",
			changeMode: "set-scalar",
			effectSummary: "sets allowWrite",
			conflictSummary: "none",
			writeContent: '{"filesystem":{"allowWrite":["."]}}',
		}),
	) as Record<string, unknown>;

	assert.equal(validated.mutationType, "write");
	assert.equal(validated.writeContent, '{"filesystem":{"allowWrite":["."]}}');
});

test("mutation tool schema validates edit arguments", () => {
	const tool = createMutationProposalTool();
	const validated = validateToolArguments(
		tool,
		makeToolCall(tool.name, {
			mutationType: "edit",
			reasoning: "minimal change",
			changeMode: "append-array-value",
			effectSummary: "adds one deny command",
			edits: [{ oldText: '"deny": []', newText: '"deny": ["git push"]' }],
		}),
	) as Record<string, unknown>;

	assert.equal(validated.mutationType, "edit");
	assert.equal(Array.isArray(validated.edits), true);
});

test("mutation tool schema rejects missing writeContent for write mode", () => {
	const tool = createMutationProposalTool();
	assert.throws(
		() =>
			validateToolArguments(
				tool,
				makeToolCall(tool.name, {
					mutationType: "write",
					reasoning: "x",
					changeMode: "x",
					effectSummary: "x",
				}),
			),
		/Validation failed/,
	);
});

test("toMutationProposal converts validated write proposal", () => {
	const parsed = toMutationProposal({
		mutationType: "write",
		reasoning: "rewrite",
		changeMode: "replace-array",
		effectSummary: "replace domains",
		writeContent: "{}",
	});
	assert.equal(parsed.mutationType, "write");
	if (parsed.mutationType === "write") {
		assert.equal(parsed.writeContent, "{}");
	}
});

test("toMutationProposal converts validated edit proposal", () => {
	const parsed = toMutationProposal({
		mutationType: "edit",
		reasoning: "patch",
		changeMode: "append-array-value",
		effectSummary: "add one entry",
		edits: [{ oldText: "old", newText: "new" }],
	});
	assert.equal(parsed.mutationType, "edit");
	if (parsed.mutationType === "edit") {
		assert.equal(parsed.edits.length, 1);
	}
});

test("target config path matcher handles relative and absolute paths", () => {
	const cwd = "/workspace/app";
	const target = "/workspace/app/fence.json";
	assert.equal(isTargetConfigPath("fence.json", cwd, target), true);
	assert.equal(isTargetConfigPath("/workspace/app/fence.json", cwd, target), true);
	assert.equal(isTargetConfigPath(".pi/sandbox.json", cwd, target), false);
});

test("write proposal preview truncates long content", () => {
	const content = "a".repeat(1400);
	const preview = buildWriteProposalPreview("fence.json", content);
	assert.match(preview, /Tool proposal: write/);
	assert.match(preview, /truncated/);
});

test("edit proposal preview includes block count", () => {
	const preview = buildEditProposalPreview("fence.json", [
		{ oldText: "old", newText: "new" },
		{ oldText: "a", newText: "b" },
	]);
	assert.match(preview, /Proposed edit blocks: 2/);
	assert.match(preview, /Edit #1/);
	assert.match(preview, /Edit #2/);
});

test("applyExactEdits applies non-overlapping unique edits", () => {
	const input = "{\n  \"enabled\": false,\n  \"network\": {}\n}\n";
	const output = applyExactEdits(input, [
		{ oldText: '"enabled": false', newText: '"enabled": true' },
		{ oldText: '"network": {}', newText: '"network": {"allow":[]}' },
	]);
	assert.match(output, /"enabled": true/);
	assert.match(output, /"allow"/);
});

test("applyExactEdits rejects non-unique match", () => {
	const input = "x x";
	assert.throws(
		() => applyExactEdits(input, [{ oldText: "x", newText: "y" }]),
		/expected unique match/,
	);
});

test("applyExactEdits rejects overlapping edits", () => {
	const input = "abcdef";
	assert.throws(
		() =>
			applyExactEdits(input, [
				{ oldText: "abc", newText: "x" },
				{ oldText: "bcd", newText: "y" },
			]),
		/overlaps/,
	);
});

test("ensureValidFenceConfigContent accepts object json and appends newline", () => {
	const normalized = ensureValidFenceConfigContent('{"network":{}}');
	assert.equal(normalized.endsWith("\n"), true);
});

test("ensureValidFenceConfigContent accepts top-level extends", () => {
	const normalized = ensureValidFenceConfigContent('{"extends":"@base"}');
	assert.equal(normalized, '{"extends":"@base"}\n');
});
