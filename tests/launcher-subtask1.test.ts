import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	FENCE_BASE_BOOTSTRAP_CONTENT,
	GLOBAL_BOOTSTRAP_CONTENT,
	ensureBootstrapConfigs,
} from "../launcher/bootstrap-configs.ts";
import { parseLauncherArguments } from "../launcher/cli-options.ts";
import { validateFenceConfig } from "../launcher/config-guard.ts";
import { runPiFenced } from "../launcher/pi-fenced.ts";
import { PI_AGENT_DIR_ENV, resolveAgentDir, resolveFencePaths } from "../launcher/path-resolution.ts";
import { buildLaunchSpec } from "../launcher/run-under-fence.ts";

test("parseLauncherArguments keeps unknown args as pi args", () => {
	const parsed = parseLauncherArguments(["--model", "provider/model", "hello"]);
	assert.equal(parsed.withoutFence, false);
	assert.equal(parsed.fenceMonitor, false);
	assert.equal(parsed.allowSelfModify, false);
	assert.deepEqual(parsed.piArgs, ["--model", "provider/model", "hello"]);
	assert.deepEqual(parsed.warnings, []);
});

test("parseLauncherArguments handles launcher flags and separator", () => {
	const parsed = parseLauncherArguments([
		"--fence-monitor",
		"--allow-self-modify",
		"--",
		"--model",
		"x/y",
	]);
	assert.equal(parsed.withoutFence, false);
	assert.equal(parsed.fenceMonitor, true);
	assert.equal(parsed.allowSelfModify, true);
	assert.deepEqual(parsed.piArgs, ["--model", "x/y"]);
	assert.deepEqual(parsed.warnings, []);
});

test("parseLauncherArguments ignores monitor in without-fence mode with warning", () => {
	const parsed = parseLauncherArguments(["--without-fence", "--fence-monitor"]);
	assert.equal(parsed.withoutFence, true);
	assert.equal(parsed.fenceMonitor, false);
	assert.equal(parsed.allowSelfModify, false);
	assert.deepEqual(parsed.warnings, ["--fence-monitor ignored in --without-fence mode"]);
});

test("parseLauncherArguments recognizes persistent macOS pasteboard flags", () => {
	const parsed = parseLauncherArguments([
		"--allow-macos-pasteboard-permanently",
		"--",
		"--model",
		"x/y",
	]);
	assert.equal(parsed.allowMacosPasteboardPermanently, true);
	assert.equal(parsed.disallowMacosPasteboardPermanently, false);
	assert.deepEqual(parsed.piArgs, ["--model", "x/y"]);
});

test("parseLauncherArguments rejects conflicting persistent macOS pasteboard flags", () => {
	assert.throws(
		() =>
			parseLauncherArguments([
				"--allow-macos-pasteboard-permanently",
				"--disallow-macos-pasteboard-permanently",
			]),
		/cannot be used together/,
	);
});

test("resolveAgentDir defaults to ~/.pi/agent", () => {
	const resolved = resolveAgentDir({ env: {}, homeDir: "/Users/test" });
	assert.equal(resolved, "/Users/test/.pi/agent");
});

test("resolveAgentDir respects PI_CODING_AGENT_DIR with tilde expansion", () => {
	const resolved = resolveAgentDir({
		env: { [PI_AGENT_DIR_ENV]: "~/custom-agent" },
		homeDir: "/Users/test",
	});
	assert.equal(resolved, "/Users/test/custom-agent");
});

test("resolveFencePaths returns Fence base and PI global paths", () => {
	const paths = resolveFencePaths({ env: {}, homeDir: "/Users/test" });
	assert.equal(paths.fenceBaseConfigPath, "/Users/test/.config/fence/fence.json");
	assert.equal(paths.globalConfigPath, "/Users/test/.pi/agent/fence/global.json");
	assert.equal(paths.preferencesPath, "/Users/test/.pi/agent/pi-fenced/preferences.json");
});

test("ensureBootstrapConfigs writes defaults once and then stays idempotent", () => {
	const createdFiles = new Set<string>();
	const writes: Array<{ path: string; content: string }> = [];
	const mkdirs: string[] = [];

	const fileOps = {
		existsSync: (pathValue: string) => createdFiles.has(pathValue),
		mkdirSync: (pathValue: string) => {
			mkdirs.push(pathValue);
		},
		writeFileSync: (pathValue: string, content: string) => {
			createdFiles.add(pathValue);
			writes.push({ path: pathValue, content });
		},
	};

	const paths = {
		fenceBaseConfigPath: "/Users/test/.config/fence/fence.json",
		globalConfigPath: "/Users/test/.pi/agent/fence/global.json",
		preferencesPath: "/Users/test/.pi/agent/pi-fenced/preferences.json",
	};

	const first = ensureBootstrapConfigs(paths, fileOps);
	const second = ensureBootstrapConfigs(paths, fileOps);

	assert.deepEqual(first, {
		createdFenceBaseConfig: true,
		createdGlobalConfig: true,
	});
	assert.deepEqual(second, {
		createdFenceBaseConfig: false,
		createdGlobalConfig: false,
	});
	assert.deepEqual(writes, [
		{ path: paths.fenceBaseConfigPath, content: FENCE_BASE_BOOTSTRAP_CONTENT },
		{ path: paths.globalConfigPath, content: GLOBAL_BOOTSTRAP_CONTENT },
	]);
	assert.deepEqual(mkdirs, [
		"/Users/test/.config/fence",
		"/Users/test/.pi/agent/fence",
	]);
});

function createGlobalPaths() {
	return {
		agentDir: "/Users/test/.pi/agent",
		fenceBaseConfigPath: "/Users/test/.config/fence/fence.json",
		globalConfigPath: "/Users/test/.pi/agent/fence/global.json",
		preferencesPath: "/Users/test/.pi/agent/pi-fenced/preferences.json",
	};
}

test("buildLaunchSpec builds fenced invocation", () => {
	const spec = buildLaunchSpec({
		withoutFence: false,
		fenceMonitor: true,
		configPath: "/Users/test/.pi/agent/fence/global.json",
		piArgs: ["--model", "x/y"],
		baseEnv: { PATH: "x" },
	});

	assert.equal(spec.command, "fence");
	assert.deepEqual(spec.args, [
		"-m",
		"--settings",
		"/Users/test/.pi/agent/fence/global.json",
		"--",
		"pi",
		"--model",
		"x/y",
	]);
	assert.equal(spec.env.PI_FENCED_LAUNCHER, "1");
});

test("buildLaunchSpec builds unfenced invocation", () => {
	const spec = buildLaunchSpec({
		withoutFence: true,
		fenceMonitor: false,
		piArgs: ["--model", "x/y"],
		baseEnv: { PATH: "x" },
	});

	assert.equal(spec.command, "pi");
	assert.deepEqual(spec.args, ["--model", "x/y"]);
	assert.equal(spec.env.PI_FENCED_LAUNCHER, "1");
});

test("validateFenceConfig passes when validator succeeds", () => {
	validateFenceConfig("/tmp/a.json", () => ({ exitCode: 0, stderr: "", stdout: "ok" }));
});

test("validateFenceConfig throws when validator fails", () => {
	assert.throws(
		() =>
			validateFenceConfig("/tmp/a.json", () => ({
				exitCode: 2,
				stderr: "invalid config",
				stdout: "",
			})),
		/invalid config/,
	);
});

test("runPiFenced uses locked runtime settings in fenced mode by default", () => {
	const warnings: string[] = [];
	const events: string[] = [];
	const buildInputs: Array<{
		withoutFence: boolean;
		fenceMonitor: boolean;
		configPath?: string;
		piArgs: string[];
		baseEnv?: NodeJS.ProcessEnv;
	}> = [];

	const exitCode = runPiFenced({
		argv: ["--fence-monitor", "--", "--model", "provider/model"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {
				events.push("bootstrap");
			},
			readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
			writeLauncherPreferences: () => {},
			getPlatform: () => "darwin",
			writeLockedSettingsFile: () => {
				events.push("lock");
				return {
					settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
					protectedWritePaths: [],
				};
			},
			validateFenceConfig: (pathValue) => {
				events.push(`validate:${pathValue}`);
			},
			buildLaunchSpec: (input) => {
				buildInputs.push(input);
				return { command: "fence", args: ["--settings", input.configPath ?? ""], env: {} };
			},
			runLaunchSpec: () => ({
				exitCode: 7,
			}),
		},
	});

	assert.equal(exitCode, 7);
	assert.deepEqual(warnings, []);
	assert.deepEqual(events, [
		"bootstrap",
		"lock",
		"validate:/tmp/pi-fenced/runtime/launcher-locked-settings.json",
	]);
	assert.equal(buildInputs.length, 1);
	assert.deepEqual(buildInputs[0], {
		withoutFence: false,
		fenceMonitor: true,
		configPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
		piArgs: ["--model", "provider/model"],
		baseEnv: { PATH: "/bin" },
	});
});

test("runPiFenced removes generated locked settings file on exit", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const runtimeRoot = mkdtempSync("/tmp/pi/pi-fenced-launcher-cleanup-");
	const settingsPath = join(runtimeRoot, "runtime", "launcher-locked-settings.test.json");

	try {
		const exitCode = runPiFenced({
			argv: ["--", "hello"],
			env: { PATH: "/bin" },
			dependencies: {
				warn: () => {},
				resolveFencePaths: () => createGlobalPaths(),
				ensureBootstrapConfigs: () => {},
				readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
				writeLauncherPreferences: () => {},
				getPlatform: () => "darwin",
				writeLockedSettingsFile: () => {
					mkdirSync(dirname(settingsPath), { recursive: true });
					writeFileSync(settingsPath, "{}\n", "utf-8");
					return {
						settingsPath,
						protectedWritePaths: [],
					};
				},
				validateFenceConfig: () => {},
				buildLaunchSpec: (input) => ({ command: "fence", args: [input.configPath ?? ""], env: {} }),
				runLaunchSpec: () => ({ exitCode: 0 }),
			},
		});

		assert.equal(exitCode, 0);
		assert.equal(existsSync(settingsPath), false);
	} finally {
		rmSync(runtimeRoot, { recursive: true, force: true });
	}
});

test("runPiFenced skips locked settings when unlock flag is enabled", () => {
	const warnings: string[] = [];
	let lockCalls = 0;
	let validateCalls: string[] = [];

	const exitCode = runPiFenced({
		argv: ["--allow-self-modify", "--", "hello"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {},
			readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
			writeLauncherPreferences: () => {},
			getPlatform: () => "darwin",
			writeLockedSettingsFile: () => {
				lockCalls += 1;
				return {
					settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
					protectedWritePaths: [],
				};
			},
			validateFenceConfig: (pathValue) => {
				validateCalls.push(pathValue);
			},
			buildLaunchSpec: (input) => ({ command: "fence", args: [input.configPath ?? ""], env: {} }),
			runLaunchSpec: () => ({ exitCode: 0 }),
		},
	});

	assert.equal(exitCode, 0);
	assert.equal(lockCalls, 0);
	assert.deepEqual(validateCalls, ["/Users/test/.pi/agent/fence/global.json"]);
	assert.match(warnings.join("\n"), /SELF-MODIFY UNLOCKED/);
});

test("runPiFenced uses runtime overlay when persistent macOS pasteboard access is enabled", () => {
	const warnings: string[] = [];
	const writePreferenceCalls: Array<{ pathValue: string; value: boolean }> = [];
	const lockInputs: Array<{
		launcherPreferencesPath?: string;
		includeDenyWrite?: boolean;
		enableMacosPasteboard?: boolean;
	}> = [];
	const validateCalls: string[] = [];

	const exitCode = runPiFenced({
		argv: ["--allow-self-modify", "--allow-macos-pasteboard-permanently", "--", "hello"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {},
			readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
			writeLauncherPreferences: (pathValue, preferences) => {
				writePreferenceCalls.push({
					pathValue,
					value: preferences.allowMacosPasteboard,
				});
			},
			getPlatform: () => "darwin",
			writeLockedSettingsFile: (input) => {
				lockInputs.push({
					launcherPreferencesPath: input.launcherPreferencesPath,
					includeDenyWrite: input.includeDenyWrite,
					enableMacosPasteboard: input.enableMacosPasteboard,
				});
				return {
					settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
					protectedWritePaths: [],
				};
			},
			validateFenceConfig: (pathValue) => {
				validateCalls.push(pathValue);
			},
			buildLaunchSpec: (input) => ({ command: "fence", args: [input.configPath ?? ""], env: {} }),
			runLaunchSpec: () => ({ exitCode: 0 }),
		},
	});

	assert.equal(exitCode, 0);
	assert.deepEqual(writePreferenceCalls, [
		{
			pathValue: "/Users/test/.pi/agent/pi-fenced/preferences.json",
			value: true,
		},
	]);
	assert.deepEqual(lockInputs, [
		{
			launcherPreferencesPath: "/Users/test/.pi/agent/pi-fenced/preferences.json",
			includeDenyWrite: false,
			enableMacosPasteboard: true,
		},
	]);
	assert.deepEqual(validateCalls, ["/tmp/pi-fenced/runtime/launcher-locked-settings.json"]);
	assert.match(warnings.join("\n"), /SELF-MODIFY UNLOCKED/);
	assert.match(
		warnings.join("\n"),
		/macOS pasteboard access permanently enabled for future fenced runs/,
	);
	assert.match(warnings.join("\n"), /macOS pasteboard access active for this fenced run/);
});

test("runPiFenced refuses --without-fence unless unlock flag is provided", () => {
	assert.throws(
		() =>
			runPiFenced({
				argv: ["--without-fence", "--", "hello"],
				env: { PATH: "/bin" },
				dependencies: {
					resolveFencePaths: () => createGlobalPaths(),
					ensureBootstrapConfigs: () => {},
					readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
					writeLauncherPreferences: () => {},
					getPlatform: () => "darwin",
					writeLockedSettingsFile: () => ({
						settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
						protectedWritePaths: [],
					}),
					validateFenceConfig: () => {},
					buildLaunchSpec: () => ({ command: "pi", args: [], env: {} }),
					runLaunchSpec: () => ({ exitCode: 0 }),
				},
			}),
		/--without-fence requires --allow-self-modify/,
	);
});

test("runPiFenced allows --without-fence when unlock flag is provided", () => {
	const warnings: string[] = [];
	let validateCalls = 0;
	let bootstrapCalls = 0;
	const buildInputs: Array<{ withoutFence: boolean; fenceMonitor: boolean }> = [];

	const exitCode = runPiFenced({
		argv: ["--without-fence", "--allow-self-modify", "--fence-monitor", "--", "hello"],
		env: { PATH: "/bin" },
		dependencies: {
			warn: (message) => warnings.push(message),
			resolveFencePaths: () => createGlobalPaths(),
			ensureBootstrapConfigs: () => {
				bootstrapCalls += 1;
			},
			readLauncherPreferences: () => ({ allowMacosPasteboard: false }),
			writeLauncherPreferences: () => {},
			getPlatform: () => "darwin",
			writeLockedSettingsFile: () => ({
				settingsPath: "/tmp/pi-fenced/runtime/launcher-locked-settings.json",
				protectedWritePaths: [],
			}),
			validateFenceConfig: () => {
				validateCalls += 1;
			},
			buildLaunchSpec: (input) => {
				buildInputs.push({
					withoutFence: input.withoutFence,
					fenceMonitor: input.fenceMonitor,
				});
				return { command: "pi", args: input.piArgs, env: {} };
			},
			runLaunchSpec: () => ({ exitCode: 0 }),
		},
	});

	assert.equal(exitCode, 0);
	assert.equal(bootstrapCalls, 1);
	assert.equal(validateCalls, 0);
	assert.deepEqual(buildInputs, [{ withoutFence: true, fenceMonitor: false }]);
	assert.match(warnings[0], /--fence-monitor ignored in --without-fence mode/);
	assert.match(warnings.join("\n"), /SELF-MODIFY UNLOCKED/);
});
