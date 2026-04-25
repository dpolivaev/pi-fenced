import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildGlobalRequestEnvelope,
	composeInvalidConfigureFenceFeedback,
	composeShowFenceConfigOutput,
	isLauncherManagedRuntime,
	registerPiFencedExtension,
	writeRequestArtifacts,
} from "../index.ts";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeApiHarness {
	api: ExtensionAPI;
	commands: Map<string, RegisteredCommand>;
	sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void>;
	execCalls: Array<{ command: string; args: string[] }>;
}

function createFakeApiHarness(options?: {
	execResult?: { stdout: string; stderr: string; code: number; killed: boolean };
}): FakeApiHarness {
	const commands = new Map<string, RegisteredCommand>();
	const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void> = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];

	const execResult =
		options?.execResult ??
		({ stdout: "", stderr: "", code: 0, killed: false } as {
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		});

	const api = {
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			if (event === "session_start") {
				sessionStartHandlers.push(handler);
			}
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			return execResult;
		},
	} as unknown as ExtensionAPI;

	return {
		api,
		commands,
		sessionStartHandlers,
		execCalls,
	};
}

test("isLauncherManagedRuntime returns true only when PI_FENCED_LAUNCHER=1", () => {
	assert.equal(isLauncherManagedRuntime({ PI_FENCED_LAUNCHER: "1" }), true);
	assert.equal(isLauncherManagedRuntime({ PI_FENCED_LAUNCHER: "0" }), false);
	assert.equal(isLauncherManagedRuntime({}), false);
});

test("registerPiFencedExtension unmanaged mode warns and shuts down", async () => {
	const harness = createFakeApiHarness();
	registerPiFencedExtension(harness.api, { PI_FENCED_LAUNCHER: "0" });

	assert.equal(harness.commands.size, 0);
	assert.equal(harness.sessionStartHandlers.length, 1);

	const notifications: Array<{ message: string; type: string | undefined }> = [];
	let shutdownCalls = 0;
	await harness.sessionStartHandlers[0](
		{ type: "session_start", reason: "startup" },
		{
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
			},
			shutdown: () => {
				shutdownCalls += 1;
			},
		},
	);

	assert.equal(shutdownCalls, 1);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /launcher-managed runtime/);
	assert.equal(notifications[0].type, "warning");
});

test("registerPiFencedExtension managed mode registers commands", async () => {
	const harness = createFakeApiHarness();
	registerPiFencedExtension(harness.api, {
		PI_FENCED_LAUNCHER: "1",
		FENCE_SANDBOX: "1",
	});

	assert.equal(harness.commands.has("configure-fence"), true);
	assert.equal(harness.commands.has("show-fence-config"), true);
	assert.equal(harness.sessionStartHandlers.length, 1);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	await harness.sessionStartHandlers[0](
		{ type: "session_start", reason: "startup" },
		{
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			},
		},
	);

	assert.deepEqual(statuses, [{ key: "pi-fenced", text: "🔒 fence" }]);
});

test("registerPiFencedExtension shows yolo status when fence is disabled", async () => {
	const harness = createFakeApiHarness();
	registerPiFencedExtension(harness.api, {
		PI_FENCED_LAUNCHER: "1",
	});

	assert.equal(harness.sessionStartHandlers.length, 1);

	const statuses: Array<{ key: string; text: string | undefined }> = [];
	await harness.sessionStartHandlers[0](
		{ type: "session_start", reason: "startup" },
		{
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			},
		},
	);

	assert.deepEqual(statuses, [{ key: "pi-fenced", text: "yolo" }]);
});

test("configure-fence command requires inline request text", async () => {
	const harness = createFakeApiHarness();
	registerPiFencedExtension(harness.api, {
		PI_FENCED_LAUNCHER: "1",
		PI_CODING_AGENT_DIR: "/tmp/pi/agent-under-test",
	});

	const command = harness.commands.get("configure-fence");
	assert.ok(command, "configure-fence command should be registered");

	let inputCalls = 0;
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const editorTextValues: string[] = [];
	await command!.handler("", {
		ui: {
			input: async () => {
				inputCalls += 1;
				return "allow localhost";
			},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setEditorText: (text: string) => editorTextValues.push(text),
		},
	});

	assert.equal(inputCalls, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "info");
	assert.match(notifications[0].message, /Usage: \/configure-fence <change request>/);
	assert.deepEqual(editorTextValues, ["/configure-fence "]);
});

test("buildGlobalRequestEnvelope builds replace-only global request with base hash", () => {
	const existingContent = '{"network":{"allow":["localhost"]}}\n';
	const envelope = buildGlobalRequestEnvelope({
		requestId: "request-123",
		targetPath: "/tmp/pi/agent/fence/global.json",
		proposalPath: "/tmp/pi-fenced/proposals/request-123.json",
		existingContent,
		summary: "Allow localhost",
		createdAt: "2026-04-22T00:00:00.000Z",
	});

	const expectedBaseSha = createHash("sha256").update(existingContent, "utf8").digest("hex");
	assert.equal(envelope.version, 1);
	assert.equal(envelope.scope, "global");
	assert.equal(envelope.mutationType, "replace");
	assert.equal(envelope.requestedBy, "pi-fenced-extension");
	assert.equal(envelope.baseSha256, expectedBaseSha);
});

test("writeRequestArtifacts persists request/proposal pair", () => {
	const proposalPath = "/tmp/pi-fenced/proposals/req-1.json";
	const requestPath = "/tmp/pi-fenced/control/request-req-1.json";
	const requestEnvelope = buildGlobalRequestEnvelope({
		requestId: "req-1",
		targetPath: "/tmp/pi/agent/fence/global.json",
		proposalPath,
		existingContent: "{}\n",
		summary: "Allow localhost",
		createdAt: "2026-04-22T00:00:00.000Z",
	});

	const fileContents = new Map<string, string>();
	const createdDirs: string[] = [];
	writeRequestArtifacts(
		{
			proposalPath,
			requestPath,
			proposalContent: '{"network":{"allow":["localhost"]}}\n',
			requestEnvelope,
		},
		{
			mkdirSync: (pathValue) => {
				createdDirs.push(pathValue);
			},
			writeFileSync: (pathValue, content) => {
				fileContents.set(pathValue, content);
			},
			existsSync: (pathValue) => fileContents.has(pathValue),
			unlinkSync: (pathValue) => {
				fileContents.delete(pathValue);
			},
		},
	);

	assert.deepEqual(createdDirs, [dirname(proposalPath), dirname(requestPath)]);
	assert.equal(
		fileContents.get(proposalPath),
		'{"network":{"allow":["localhost"]}}\n',
	);
	assert.equal(
		fileContents.get(requestPath),
		`${JSON.stringify(requestEnvelope, null, "  ")}\n`,
	);
});

test("writeRequestArtifacts cleans partial files when request write fails", () => {
	const proposalPath = "/tmp/pi-fenced/proposals/req-2.json";
	const requestPath = "/tmp/pi-fenced/control/request-req-2.json";
	const requestEnvelope = buildGlobalRequestEnvelope({
		requestId: "req-2",
		targetPath: "/tmp/pi/agent/fence/global.json",
		proposalPath,
		existingContent: "{}\n",
		summary: "Deny github.com",
		createdAt: "2026-04-22T00:00:00.000Z",
	});

	const fileContents = new Map<string, string>();
	assert.throws(
		() =>
			writeRequestArtifacts(
				{
					proposalPath,
					requestPath,
					proposalContent: '{"network":{"deny":["github.com"]}}\n',
					requestEnvelope,
				},
				{
					mkdirSync: () => {},
					writeFileSync: (pathValue, content) => {
						fileContents.set(pathValue, content);
						if (pathValue === requestPath) {
							throw new Error("disk full");
						}
					},
					existsSync: (pathValue) => fileContents.has(pathValue),
					unlinkSync: (pathValue) => {
						fileContents.delete(pathValue);
					},
				},
			),
		/Failed to persist request\/proposal artifacts: disk full/,
	);

	assert.equal(fileContents.has(proposalPath), false);
	assert.equal(fileContents.has(requestPath), false);
});

test("composeShowFenceConfigOutput keeps stderr and stdout verbatim order", () => {
	const output = composeShowFenceConfigOutput("stderr-line\n", "{\"a\":1}\n");
	assert.equal(output, "stderr-line\n{\"a\":1}\n");
});

test("composeInvalidConfigureFenceFeedback explains non-actionable requests", () => {
	const message = composeInvalidConfigureFenceFeedback("Request is too vague.");
	assert.match(message, /not actionable/);
	assert.match(message, /Request is too vague\./);
	assert.match(message, /concrete Fence policy change/);
});

test("show-fence-config command executes fence and shows combined output", async () => {
	const harness = createFakeApiHarness({
		execResult: {
			stderr: "chain: @base -> code\n",
			stdout: '{"network":{"allow":["localhost"]}}\n',
			code: 0,
			killed: false,
		},
	});

	registerPiFencedExtension(harness.api, {
		PI_FENCED_LAUNCHER: "1",
		PI_CODING_AGENT_DIR: "/tmp/pi/agent-under-test",
	});

	const command = harness.commands.get("show-fence-config");
	assert.ok(command, "show-fence-config command should be registered");

	const customRenders: string[][] = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];

	await command!.handler("", {
		cwd: "/workspace/project",
		signal: undefined,
		ui: {
			custom: async (factory: any) => {
				const component = await factory(
					{
						terminal: { rows: 18 },
						requestRender: () => {},
					},
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					},
					{
						matches: () => false,
					},
					() => {},
				);
				customRenders.push(component.render(120));
				return undefined;
			},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	});

	assert.deepEqual(harness.execCalls, [
		{
			command: "fence",
			args: [
				"config",
				"show",
				"--settings",
				"/tmp/pi/agent-under-test/fence/global.json",
			],
		},
	]);
	assert.equal(customRenders.length, 1);
	assert.equal(customRenders[0][0], "/show-fence-config (read-only)");
	assert.match(customRenders[0][1], /READ-ONLY/);
	assert.ok(customRenders[0].includes("chain: @base -> code"));
	assert.ok(customRenders[0].includes('{"network":{"allow":["localhost"]}}'));
	assert.equal(notifications.length, 0);
});
