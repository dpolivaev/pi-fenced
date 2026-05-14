import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PI_FENCED_ACTIVE_LAUNCH_STATE_PATH_ENV,
	createActiveLaunchStatePath,
	initializeActiveLaunchState,
	readActiveLaunchSessionPath,
} from "./active-launch-state.ts";
import {
	listGlobalPresetNames,
	readSelectedPresetName,
	resolvePresetPath,
	resolveSelectedGlobalPreset,
	writeSelectedPresetName,
} from "./global-presets.ts";
import {
	APPLY_CALLER_ENV_KEY,
	APPLY_CALLER_ENV_VALUE,
	runPiFencedApply,
} from "../apply/pi-fenced-apply.ts";
import type { ApplyOutcome } from "../apply/outcome.ts";
import { ensureBootstrapConfigs } from "./bootstrap-configs.ts";
import { parseLauncherArguments } from "./cli-options.ts";
import { validateFenceConfig } from "./config-guard.ts";
import { resolveFencePaths, type ResolvedFencePaths } from "./path-resolution.ts";
import {
	writeLockedSettingsFile,
	type SelfProtectionResult,
} from "./self-protection.ts";
import {
	readLauncherPreferences,
	writeLauncherPreferences,
	type LauncherPreferences,
} from "./preferences.ts";
import {
	buildLaunchSpec,
	runLaunchSpec,
	type BuildLaunchSpecInput,
	type LaunchSpec,
} from "./run-under-fence.ts";

export interface RunPiFencedDependencies {
	warn: (message: string) => void;
	resolveFencePaths: (input: { env: NodeJS.ProcessEnv }) => ResolvedFencePaths;
	ensureBootstrapConfigs: (
		paths: Pick<ResolvedFencePaths, "fenceBaseConfigPath" | "defaultPresetPath" | "selectionPath">,
	) => void;
	resolveSelectedGlobalPreset: (
		paths: Pick<ResolvedFencePaths, "presetsDirectoryPath" | "selectionPath">,
	) => { presetName: string; presetPath: string };
	readLauncherPreferences: (preferencesPath: string) => LauncherPreferences;
	writeLauncherPreferences: (
		preferencesPath: string,
		preferences: LauncherPreferences,
	) => void;
	getPlatform: () => NodeJS.Platform;
	validateFenceConfig: (configPath: string) => void;
	writeLockedSettingsFile: (input: {
		activePresetPath: string;
		fencePaths: Pick<ResolvedFencePaths, "fenceDirectoryPath" | "fenceBaseConfigPath">;
		launcherPreferencesPath?: string;
		includeDenyWrite?: boolean;
		enableMacosPasteboard?: boolean;
	}) => SelfProtectionResult;
	buildLaunchSpec: (input: BuildLaunchSpecInput) => LaunchSpec;
	runLaunchSpec: (spec: LaunchSpec) => { exitCode: number };
	createActiveLaunchStatePath: () => string;
	initializeActiveLaunchState: (statePath: string, activeGlobalPresetPath: string) => void;
	readActiveLaunchSessionPath: (statePath: string) => string | undefined;
}

export interface RunPiFencedInput {
	argv: string[];
	env?: NodeJS.ProcessEnv;
	dependencies?: Partial<RunPiFencedDependencies>;
}

export interface RunPiFencedLoopDependencies extends RunPiFencedDependencies {
	runPiFencedApply: (input: { env: NodeJS.ProcessEnv }) => Promise<ApplyOutcome>;
}

export interface RunPiFencedLoopInput {
	argv: string[];
	env?: NodeJS.ProcessEnv;
	dependencies?: Partial<RunPiFencedLoopDependencies>;
}

interface PreparedLaunchContext<TDependencies extends RunPiFencedDependencies> {
	env: NodeJS.ProcessEnv;
	parsed: ReturnType<typeof parseLauncherArguments>;
	paths: ResolvedFencePaths;
	activePresetName: string;
	activePresetPath: string;
	activeSettingsPath: string;
	generatedLockedSettingsPath?: string;
	activeLaunchStatePath: string;
	dependencies: TDependencies;
}

const DEFAULT_WARNING_PREFIX = "pi-fenced:";

export const PI_FENCED_HELP_TEXT = [
	"pi-fenced - PI launcher for Fence-managed sessions",
	"",
	"Usage:",
	"  pi-fenced [launcher options] [--] [pi args...]",
	"  pi-fenced preset list",
	"  pi-fenced preset current",
	"  pi-fenced preset use <name>",
	"",
	"Launcher options:",
	"  --help",
	"      Show pi-fenced help, then pi --help",
	"  --fence-monitor",
	"      Enable Fence monitor mode",
	"  --without-fence",
	"      Run pi directly (requires --allow-self-modify)",
	"  --allow-self-modify",
	"      Disable default self-protection for this run",
	"  --allow-macos-pasteboard-permanently",
	"      Persist fenced macOS pasteboard access opt-in",
	"  --disallow-macos-pasteboard-permanently",
	"      Remove fenced macOS pasteboard access opt-in",
	"",
	"Forwarding:",
	"  Remaining args are forwarded to pi.",
	"  Use -- to force all following tokens to be treated as pi args.",
].join("\n");

interface MainDependencies {
	handlePresetCommand: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;
	runRestartLoop: (input: RunPiFencedLoopInput) => Promise<number>;
	runPiHelp: (env: NodeJS.ProcessEnv) => number;
	writeStdout: (text: string) => void;
	writeStderr: (text: string) => void;
}

interface HelpCommandRunnerResult {
	status: number | null;
	error?: Error;
}

type HelpCommandRunner = (
	command: string,
	args: string[],
	options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => HelpCommandRunnerResult;

function runPiHelpCommand(
	env: NodeJS.ProcessEnv,
	runner: HelpCommandRunner = (command, args, options) => {
		const result = spawnSync(command, args, {
			stdio: options.stdio,
			env: options.env,
		});
		return {
			status: result.status,
			error: result.error,
		};
	},
): number {
	const result = runner("pi", ["--help"], {
		stdio: "inherit",
		env,
	});

	if (result.error) {
		throw result.error;
	}

	return result.status ?? 1;
}

function createMainDependencies(
	overrides: Partial<MainDependencies> | undefined,
): MainDependencies {
	return {
		handlePresetCommand,
		runRestartLoop: (input) => runPiFencedWithRestartLoop(input),
		runPiHelp: (env) => runPiHelpCommand(env),
		writeStdout: (text) => {
			process.stdout.write(text);
		},
		writeStderr: (text) => {
			process.stderr.write(text);
		},
		...overrides,
	};
}

function createBaseDependencies(
	overrides: Partial<RunPiFencedDependencies> | undefined,
): RunPiFencedDependencies {
	return {
		warn: (message) => console.warn(`${DEFAULT_WARNING_PREFIX} ${message}`),
		resolveFencePaths: ({ env: envValue }) => resolveFencePaths({ env: envValue }),
		ensureBootstrapConfigs,
		resolveSelectedGlobalPreset,
		readLauncherPreferences,
		writeLauncherPreferences,
		getPlatform: () => process.platform,
		validateFenceConfig,
		writeLockedSettingsFile,
		buildLaunchSpec,
		runLaunchSpec,
		createActiveLaunchStatePath,
		initializeActiveLaunchState,
		readActiveLaunchSessionPath,
		...overrides,
	};
}

function updateLauncherPreferences(
	parsed: ReturnType<typeof parseLauncherArguments>,
	paths: ResolvedFencePaths,
	dependencies: RunPiFencedDependencies,
): LauncherPreferences {
	let preferences = dependencies.readLauncherPreferences(paths.preferencesPath);

	if (parsed.allowMacosPasteboardPermanently) {
		preferences = {
			...preferences,
			allowMacosPasteboard: true,
		};
		dependencies.writeLauncherPreferences(paths.preferencesPath, preferences);
		dependencies.warn(
			"macOS pasteboard access permanently enabled for future fenced runs.",
		);
	}

	if (parsed.disallowMacosPasteboardPermanently) {
		preferences = {
			...preferences,
			allowMacosPasteboard: false,
		};
		dependencies.writeLauncherPreferences(paths.preferencesPath, preferences);
		dependencies.warn(
			"macOS pasteboard access permanently disabled for future fenced runs.",
		);
	}

	return preferences;
}

function shouldEnableMacosPasteboardForRun(
	parsed: ReturnType<typeof parseLauncherArguments>,
	preferences: LauncherPreferences,
	dependencies: RunPiFencedDependencies,
): boolean {
	if (parsed.withoutFence) {
		return false;
	}

	if (dependencies.getPlatform() !== "darwin") {
		return false;
	}

	return preferences.allowMacosPasteboard;
}

function prepareLaunchContext<TDependencies extends RunPiFencedDependencies>(
	input: { argv: string[]; env?: NodeJS.ProcessEnv },
	dependencies: TDependencies,
): PreparedLaunchContext<TDependencies> {
	const env = input.env ?? process.env;
	const parsed = parseLauncherArguments(input.argv);
	if (parsed.presetCommand) {
		throw new Error("preset commands must be handled before launching PI");
	}
	if (parsed.helpRequested) {
		throw new Error("launcher help must be handled before launching PI");
	}
	for (const warning of parsed.warnings) {
		dependencies.warn(warning);
	}

	const paths = dependencies.resolveFencePaths({ env });
	dependencies.ensureBootstrapConfigs({
		fenceBaseConfigPath: paths.fenceBaseConfigPath,
		defaultPresetPath: paths.defaultPresetPath,
		selectionPath: paths.selectionPath,
	});
	const { presetName: activePresetName, presetPath: activePresetPath } =
		dependencies.resolveSelectedGlobalPreset({
			presetsDirectoryPath: paths.presetsDirectoryPath,
			selectionPath: paths.selectionPath,
		});
	const launcherPreferences = updateLauncherPreferences(parsed, paths, dependencies);

	if (parsed.withoutFence && !parsed.allowSelfModify) {
		throw new Error(
			"--without-fence requires --allow-self-modify because " +
				"self-protection cannot be enforced outside Fence",
		);
	}

	if (parsed.allowSelfModify) {
		dependencies.warn(
			"SELF-MODIFY UNLOCKED (--allow-self-modify): " +
				"launcher/applier and active Fence config files are writable for this run.",
		);
	}

	const enableMacosPasteboard = shouldEnableMacosPasteboardForRun(
		parsed,
		launcherPreferences,
		dependencies,
	);
	if (enableMacosPasteboard) {
		dependencies.warn("macOS pasteboard access active for this fenced run.");
	}

	let activeSettingsPath = activePresetPath;
	let generatedLockedSettingsPath: string | undefined;
	if (!parsed.withoutFence && (enableMacosPasteboard || !parsed.allowSelfModify)) {
		const lockedSettings = dependencies.writeLockedSettingsFile({
			activePresetPath,
			fencePaths: {
				fenceDirectoryPath: paths.fenceDirectoryPath,
				fenceBaseConfigPath: paths.fenceBaseConfigPath,
			},
			launcherPreferencesPath: paths.preferencesPath,
			includeDenyWrite: !parsed.allowSelfModify,
			enableMacosPasteboard,
		});
		activeSettingsPath = lockedSettings.settingsPath;
		generatedLockedSettingsPath = lockedSettings.settingsPath;
	}

	const activeLaunchStatePath = dependencies.createActiveLaunchStatePath();
	dependencies.initializeActiveLaunchState(activeLaunchStatePath, activePresetPath);

	return {
		env,
		parsed,
		paths,
		activePresetName,
		activePresetPath,
		activeSettingsPath,
		generatedLockedSettingsPath,
		activeLaunchStatePath,
		dependencies,
	};
}

function launchSinglePiSession(
	context: PreparedLaunchContext<RunPiFencedDependencies>,
	piArgs: string[],
): number {
	if (!context.parsed.withoutFence) {
		context.dependencies.validateFenceConfig(context.activeSettingsPath);
	}

	const spec = context.dependencies.buildLaunchSpec({
		withoutFence: context.parsed.withoutFence,
		fenceMonitor: context.parsed.fenceMonitor,
		configPath: context.activeSettingsPath,
		piArgs,
		baseEnv: context.env,
	});
	spec.env[PI_FENCED_ACTIVE_LAUNCH_STATE_PATH_ENV] = context.activeLaunchStatePath;

	return context.dependencies.runLaunchSpec(spec).exitCode;
}

function cleanupGeneratedLockedSettingsFile(
	context: PreparedLaunchContext<RunPiFencedDependencies>,
): void {
	const settingsPath = context.generatedLockedSettingsPath;
	if (!settingsPath) {
		return;
	}

	if (!existsSync(settingsPath)) {
		return;
	}

	try {
		unlinkSync(settingsPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.dependencies.warn(
			`failed to cleanup locked runtime settings file ${settingsPath}: ${message}`,
		);
	}
}

function cleanupActiveLaunchStateFile(
	context: PreparedLaunchContext<RunPiFencedDependencies>,
): void {
	if (!existsSync(context.activeLaunchStatePath)) {
		return;
	}

	try {
		unlinkSync(context.activeLaunchStatePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.dependencies.warn(
			`failed to cleanup active launch state file ${context.activeLaunchStatePath}: ${message}`,
		);
	}
}

function shouldRestartAfterApplyOutcome(outcome: ApplyOutcome): boolean {
	return outcome.type !== "no-request";
}

export function hasNoSessionFlag(piArgs: string[]): boolean {
	return piArgs.includes("--no-session");
}

export function stripSessionSelectorArgs(piArgs: string[]): string[] {
	const stripped: string[] = [];
	for (let index = 0; index < piArgs.length; index += 1) {
		const arg = piArgs[index];
		if (
			arg === "-c" ||
			arg === "--continue" ||
			arg === "-r" ||
			arg === "--resume"
		) {
			continue;
		}

		if (arg === "--session" || arg === "--fork") {
			const next = piArgs[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				index += 1;
			}
			continue;
		}

		if (arg.startsWith("--session=") || arg.startsWith("--fork=")) {
			continue;
		}

		stripped.push(arg);
	}

	return stripped;
}

export function buildRelaunchPiArgs(
	basePiArgs: string[],
	launchSessionPath: string | undefined,
): string[] {
	if (
		typeof launchSessionPath !== "string" ||
		launchSessionPath.trim().length === 0 ||
		hasNoSessionFlag(basePiArgs)
	) {
		return [...basePiArgs];
	}

	return ["--session", launchSessionPath, ...stripSessionSelectorArgs(basePiArgs)];
}

function logApplyOutcome(outcome: ApplyOutcome, warn: (message: string) => void): void {
	if (outcome.type === "no-request") {
		return;
	}

	warn(`apply outcome [${outcome.type}]: ${outcome.message}`);
}

export function runPiFenced(input: RunPiFencedInput): number {
	const dependencies = createBaseDependencies(input.dependencies);
	const context = prepareLaunchContext(input, dependencies);
	try {
		return launchSinglePiSession(context, context.parsed.piArgs);
	} finally {
		cleanupGeneratedLockedSettingsFile(context);
		cleanupActiveLaunchStateFile(context);
	}
}

export async function runPiFencedWithRestartLoop(input: RunPiFencedLoopInput): Promise<number> {
	const baseDependencies = createBaseDependencies(input.dependencies);
	const dependencies: RunPiFencedLoopDependencies = {
		...baseDependencies,
		runPiFencedApply: ({ env }) =>
			runPiFencedApply({
				env: {
					...env,
					[APPLY_CALLER_ENV_KEY]: APPLY_CALLER_ENV_VALUE,
				},
			}),
		...(input.dependencies ?? {}),
	};

	const context = prepareLaunchContext(input, dependencies);
	let nextLaunchPiArgs = [...context.parsed.piArgs];

	try {
		while (true) {
			const launchExitCode = launchSinglePiSession(context, nextLaunchPiArgs);

			let applyOutcome: ApplyOutcome;
			try {
				applyOutcome = await dependencies.runPiFencedApply({ env: context.env });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				dependencies.warn(`apply workflow failed unexpectedly: ${message}`);
				continue;
			}

			logApplyOutcome(applyOutcome, dependencies.warn);
			if (!shouldRestartAfterApplyOutcome(applyOutcome)) {
				return launchExitCode;
			}

			const launchSessionPath = dependencies.readActiveLaunchSessionPath(
				context.activeLaunchStatePath,
			);
			nextLaunchPiArgs = buildRelaunchPiArgs(context.parsed.piArgs, launchSessionPath);
		}
	} finally {
		cleanupGeneratedLockedSettingsFile(context);
		cleanupActiveLaunchStateFile(context);
	}
}

async function handlePresetCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const parsed = parseLauncherArguments(argv);
	const presetCommand = parsed.presetCommand;
	if (!presetCommand) {
		throw new Error("preset command expected");
	}

	const paths = resolveFencePaths({ env });
	ensureBootstrapConfigs({
		fenceBaseConfigPath: paths.fenceBaseConfigPath,
		defaultPresetPath: paths.defaultPresetPath,
		selectionPath: paths.selectionPath,
	});

	if (presetCommand.action === "current") {
		console.log(readSelectedPresetName(paths.selectionPath));
		return 0;
	}

	if (presetCommand.action === "list") {
		const currentPreset = readSelectedPresetName(paths.selectionPath);
		for (const presetName of listGlobalPresetNames(paths.presetsDirectoryPath)) {
			console.log(`${presetName === currentPreset ? "*" : " "} ${presetName}`);
		}
		return 0;
	}

	const targetPresetPath = resolvePresetPath(
		paths.presetsDirectoryPath,
		presetCommand.presetName,
	);
	if (!existsSync(targetPresetPath)) {
		throw new Error(
			`Preset "${presetCommand.presetName}" does not exist at ${targetPresetPath}`,
		);
	}

	writeSelectedPresetName(paths.selectionPath, presetCommand.presetName);
	console.log(`Selected preset: ${presetCommand.presetName}`);
	return 0;
}

export async function main(
	argv: string[] = process.argv.slice(2),
	dependenciesOverrides?: Partial<MainDependencies>,
): Promise<number> {
	const dependencies = createMainDependencies(dependenciesOverrides);

	try {
		const parsed = parseLauncherArguments(argv);
		if (parsed.presetCommand) {
			return await dependencies.handlePresetCommand(argv, process.env);
		}
		if (parsed.helpRequested) {
			dependencies.writeStdout(`${PI_FENCED_HELP_TEXT}\n\n`);
			return dependencies.runPiHelp(process.env);
		}
		return await dependencies.runRestartLoop({ argv });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		dependencies.writeStderr(`${DEFAULT_WARNING_PREFIX} ${message}\n`);
		return 1;
	}
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
			const message = error instanceof Error ? error.message : String(error);
			console.error(`${DEFAULT_WARNING_PREFIX} ${message}`);
			process.exitCode = 1;
		},
	);
}
