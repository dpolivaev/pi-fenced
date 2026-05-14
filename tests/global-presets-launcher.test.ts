import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseLauncherArguments } from "../launcher/cli-options.ts";
import {
	listGlobalPresetNames,
	readSelectedPresetName,
	writeSelectedPresetName,
} from "../launcher/global-presets.ts";
import { main } from "../launcher/pi-fenced.ts";
import {
	PI_AGENT_DIR_ENV,
	SELECTION_FILE_NAME,
	resolveFencePaths,
} from "../launcher/path-resolution.ts";

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
	const previousEnv = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previousEnv.set(key, process.env[key]);
		process.env[key] = value;
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousEnv.entries()) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

test("parseLauncherArguments recognizes preset management commands", () => {
	assert.deepEqual(parseLauncherArguments(["preset", "list"]).presetCommand, {
		action: "list",
	});
	assert.deepEqual(parseLauncherArguments(["preset", "current"]).presetCommand, {
		action: "current",
	});
	assert.deepEqual(parseLauncherArguments(["preset", "use", "travel"]).presetCommand, {
		action: "use",
		presetName: "travel",
	});
});

test("parseLauncherArguments rejects malformed preset command", () => {
	assert.throws(
		() => parseLauncherArguments(["preset", "use"]),
		/Usage: pi-fenced preset list \| current \| use <name>/,
	);
});

test("listGlobalPresetNames reads preset files from presets directory", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const rootDir = mkdtempSync("/tmp/pi/pi-fenced-preset-list-");
	const fenceDirectoryPath = join(rootDir, "fence");
	const presetsDirectoryPath = join(fenceDirectoryPath, "presets");
	mkdirSync(presetsDirectoryPath, { recursive: true });

	try {
		writeFileSync(join(presetsDirectoryPath, "default-configuration.json"), "{}\n", "utf-8");
		writeFileSync(join(presetsDirectoryPath, "travel.json"), "{}\n", "utf-8");
		writeFileSync(join(fenceDirectoryPath, SELECTION_FILE_NAME), '{"selectedPreset":"travel"}\n', "utf-8");

		assert.deepEqual(listGlobalPresetNames(presetsDirectoryPath), [
			"default-configuration",
			"travel",
		]);
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("main preset use updates persistent selection metadata", async () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const rootDir = mkdtempSync("/tmp/pi/pi-fenced-preset-main-use-");
	const homeDir = join(rootDir, "home");
	const agentDir = join(rootDir, "agent");
	mkdirSync(homeDir, { recursive: true });

	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.join(" "));
	};

	try {
		await withEnv(
			{
				HOME: homeDir,
				[PI_AGENT_DIR_ENV]: agentDir,
			},
			async () => {
				const paths = resolveFencePaths({
					homeDir,
					env: { [PI_AGENT_DIR_ENV]: agentDir },
				});
				mkdirSync(paths.presetsDirectoryPath, { recursive: true });
				writeFileSync(paths.defaultPresetPath, '{"extends":"@base"}\n', "utf-8");
				writeFileSync(
					join(paths.presetsDirectoryPath, "travel.json"),
					'{"extends":"@base"}\n',
					"utf-8",
				);
				writeSelectedPresetName(paths.selectionPath, "default-configuration");

				const exitCode = await main(["preset", "use", "travel"]);
				assert.equal(exitCode, 0);
				assert.equal(readSelectedPresetName(paths.selectionPath), "travel");
			},
		);
		assert.deepEqual(logs, ["Selected preset: travel"]);
	} finally {
		console.log = originalLog;
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("main preset list marks the currently selected preset", async () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const rootDir = mkdtempSync("/tmp/pi/pi-fenced-preset-main-list-");
	const homeDir = join(rootDir, "home");
	const agentDir = join(rootDir, "agent");
	mkdirSync(homeDir, { recursive: true });

	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.join(" "));
	};

	try {
		await withEnv(
			{
				HOME: homeDir,
				[PI_AGENT_DIR_ENV]: agentDir,
			},
			async () => {
				const paths = resolveFencePaths({
					homeDir,
					env: { [PI_AGENT_DIR_ENV]: agentDir },
				});
				mkdirSync(paths.presetsDirectoryPath, { recursive: true });
				writeFileSync(paths.defaultPresetPath, '{"extends":"@base"}\n', "utf-8");
				writeFileSync(
					join(paths.presetsDirectoryPath, "travel.json"),
					'{"extends":"@base"}\n',
					"utf-8",
				);
				writeSelectedPresetName(paths.selectionPath, "travel");

				const exitCode = await main(["preset", "list"]);
				assert.equal(exitCode, 0);
			},
		);
		assert.deepEqual(logs, ["  default-configuration", "* travel"]);
	} finally {
		console.log = originalLog;
		rmSync(rootDir, { recursive: true, force: true });
	}
});
