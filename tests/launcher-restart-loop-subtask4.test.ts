import assert from "node:assert/strict";
import test from "node:test";
import type { ApplyOutcome } from "../apply/outcome.ts";
import { runPiFencedWithRestartLoop } from "../launcher/pi-fenced.ts";

function createGlobalPaths() {
	return {
		agentDir: "/Users/test/.pi/agent",
		fenceBaseConfigPath: "/Users/test/.config/fence/fence.json",
		globalConfigPath: "/Users/test/.pi/agent/fence/global.json",
	};
}

test("runPiFencedWithRestartLoop returns PI exit code when no request is pending", async () => {
	const warnings: string[] = [];
	const launchInputs: any[] = [];
	let launchCalls = 0;
	let applyCalls = 0;
	let bootstrapCalls = 0;
	let validateCalls = 0;
	let lockCalls = 0;

	const exitCode = await runPiFencedWithRestartLoop({
		argv: ["--", "--model", "provider/model"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {
				bootstrapCalls += 1;
			},
			writeLockedSettingsFile: () => {
				lockCalls += 1;
				return {
					settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
					protectedWritePaths: [],
				};
			},
			validateFenceConfig: () => {
				validateCalls += 1;
			},
			buildLaunchSpec: (input) => {
				launchInputs.push(input);
				return { command: "fence", args: [], env: {} };
			},
			runLaunchSpec: () => {
				launchCalls += 1;
				return { exitCode: 17 };
			},
			runPiFencedApply: async (): Promise<ApplyOutcome> => {
				applyCalls += 1;
				return {
					type: "no-request",
					message: "No pending apply requests.",
				};
			},
		},
	});

	assert.equal(exitCode, 17);
	assert.equal(launchCalls, 1);
	assert.equal(applyCalls, 1);
	assert.equal(bootstrapCalls, 1);
	assert.equal(lockCalls, 1);
	assert.equal(validateCalls, 1);
	assert.equal(warnings.length, 0);
	assert.equal(launchInputs.length, 1);
	assert.deepEqual(launchInputs[0], {
		withoutFence: false,
		fenceMonitor: false,
		configPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
		piArgs: ["--model", "provider/model"],
		baseEnv: { PATH: "/bin" },
	});
});

test("runPiFencedWithRestartLoop restarts after applied request", async () => {
	const warnings: string[] = [];
	const launchInputs: any[] = [];
	const applyOutcomes: ApplyOutcome[] = [
		{
			type: "applied",
			requestId: "r1",
			message: "Applied request r1.",
		},
		{
			type: "no-request",
			message: "No pending apply requests.",
		},
	];

	let launchCalls = 0;
	let applyCalls = 0;

	const exitCode = await runPiFencedWithRestartLoop({
		argv: ["--fence-monitor", "--", "--model", "provider/model"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {},
			writeLockedSettingsFile: () => ({
				settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
				protectedWritePaths: [],
			}),
			validateFenceConfig: () => {},
			buildLaunchSpec: (input) => {
				launchInputs.push(input);
				return { command: "fence", args: [], env: {} };
			},
			runLaunchSpec: () => {
				const exitCodes = [3, 0];
				const exit = exitCodes[launchCalls] ?? 0;
				launchCalls += 1;
				return { exitCode: exit };
			},
			runPiFencedApply: async (): Promise<ApplyOutcome> => {
				const outcome = applyOutcomes[applyCalls] ?? {
					type: "no-request",
					message: "No pending apply requests.",
				};
				applyCalls += 1;
				return outcome;
			},
		},
	});

	assert.equal(exitCode, 0);
	assert.equal(launchCalls, 2);
	assert.equal(applyCalls, 2);
	assert.equal(launchInputs.length, 2);
	assert.deepEqual(launchInputs[0], launchInputs[1]);
	assert.match(warnings.join("\n"), /apply outcome \[applied\]/);
});

test("runPiFencedWithRestartLoop continues after malformed request outcome", async () => {
	const warnings: string[] = [];
	const applyOutcomes: ApplyOutcome[] = [
		{
			type: "invalid-request",
			requestId: "broken",
			message: "Invalid request file /tmp/pi-fenced/control/request-broken.json: bad JSON",
		},
		{
			type: "no-request",
			message: "No pending apply requests.",
		},
	];

	let launchCalls = 0;
	let applyCalls = 0;

	const exitCode = await runPiFencedWithRestartLoop({
		argv: ["--", "hello"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {},
			writeLockedSettingsFile: () => ({
				settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
				protectedWritePaths: [],
			}),
			validateFenceConfig: () => {},
			buildLaunchSpec: () => ({ command: "fence", args: [], env: {} }),
			runLaunchSpec: () => {
				launchCalls += 1;
				return { exitCode: launchCalls === 1 ? 1 : 0 };
			},
			runPiFencedApply: async (): Promise<ApplyOutcome> => {
				const outcome = applyOutcomes[applyCalls] ?? {
					type: "no-request",
					message: "No pending apply requests.",
				};
				applyCalls += 1;
				return outcome;
			},
		},
	});

	assert.equal(exitCode, 0);
	assert.equal(launchCalls, 2);
	assert.equal(applyCalls, 2);
	assert.match(warnings.join("\n"), /apply outcome \[invalid-request\]/);
});

test("runPiFencedWithRestartLoop preserves launcher mode and PI args across restart", async () => {
	const warnings: string[] = [];
	const buildInputs: Array<{
		withoutFence: boolean;
		fenceMonitor: boolean;
		configPath?: string;
		piArgs: string[];
	}> = [];
	let validateCalls = 0;
	let applyCalls = 0;
	let launchCalls = 0;
	let lockCalls = 0;

	const exitCode = await runPiFencedWithRestartLoop({
		argv: [
			"--without-fence",
			"--allow-self-modify",
			"--fence-monitor",
			"--",
			"--model",
			"x/y",
			"hello",
		],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {},
			writeLockedSettingsFile: () => {
				lockCalls += 1;
				return {
					settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
					protectedWritePaths: [],
				};
			},
			validateFenceConfig: () => {
				validateCalls += 1;
			},
			buildLaunchSpec: (input) => {
				buildInputs.push({
					withoutFence: input.withoutFence,
					fenceMonitor: input.fenceMonitor,
					configPath: input.configPath,
					piArgs: input.piArgs,
				});
				return { command: "pi", args: input.piArgs, env: {} };
			},
			runLaunchSpec: () => {
				launchCalls += 1;
				return { exitCode: 0 };
			},
			runPiFencedApply: async (): Promise<ApplyOutcome> => {
				applyCalls += 1;
				if (applyCalls === 1) {
					return {
						type: "conflict-cleanup",
						message: "Detected 2 pending requests. Dropped requests and linked proposals.",
					};
				}
				return {
					type: "no-request",
					message: "No pending apply requests.",
				};
			},
		},
	});

	assert.equal(exitCode, 0);
	assert.equal(launchCalls, 2);
	assert.equal(applyCalls, 2);
	assert.equal(validateCalls, 0);
	assert.equal(lockCalls, 0);
	assert.deepEqual(buildInputs, [
		{
			withoutFence: true,
			fenceMonitor: false,
			configPath: "/Users/test/.pi/agent/fence/global.json",
			piArgs: ["--model", "x/y", "hello"],
		},
		{
			withoutFence: true,
			fenceMonitor: false,
			configPath: "/Users/test/.pi/agent/fence/global.json",
			piArgs: ["--model", "x/y", "hello"],
		},
	]);
	assert.match(warnings[0], /--fence-monitor ignored in --without-fence mode/);
	assert.match(warnings.join("\n"), /SELF-MODIFY UNLOCKED/);
	assert.match(warnings.join("\n"), /apply outcome \[conflict-cleanup\]/);
});
