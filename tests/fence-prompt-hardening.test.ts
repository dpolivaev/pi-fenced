import assert from "node:assert/strict";
import test from "node:test";
import { buildMutationPrompt, buildMutationSystemPrompt } from "../index.ts";

test("buildMutationSystemPrompt injects Fence domain reference with schema markers", () => {
	const prompt = buildMutationSystemPrompt();

	assert.match(prompt, /Top-level object \(type=object, additionalProperties=false\)/);
	assert.match(prompt, /"network": object/);
	assert.match(prompt, /"filesystem": object/);
	assert.match(prompt, /"command": object/);
	assert.match(prompt, /"ssh": object/);
	assert.match(prompt, /"extends": string/);
	assert.match(prompt, /Merge semantics \(child overrides\/extends base\)/);
	assert.match(prompt, /arrays: append \+ dedupe/);
	assert.match(prompt, /booleans: OR semantics/);
	assert.match(prompt, /runtimeExecPolicy: "path" \| "argv"/);
	assert.match(prompt, /allowedDomains: string\[\]/);
	assert.match(prompt, /allowWrite: string\[\]/);
	assert.equal(prompt.includes("%%"), false);
});

test("buildMutationSystemPrompt is deterministic across calls", () => {
	const first = buildMutationSystemPrompt();
	const second = buildMutationSystemPrompt();
	assert.equal(first, second);
});

test("buildMutationPrompt resolves placeholders and keeps request context", () => {
	const prompt = buildMutationPrompt({
		requestText: "Enable strict read isolation and keep command defaults",
		targetPath: "/Users/test/.pi/agent/fence/global.json",
		existingContent: undefined,
	});

	assert.match(prompt, /Enable strict read isolation and keep command defaults/);
	assert.match(prompt, /Target file path: \/Users\/test\/.pi\/agent\/fence\/global\.json/);
	assert.match(prompt, /Target file does not exist\./);
	assert.equal(prompt.includes("%%"), false);
});
