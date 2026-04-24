import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
	buildLaunchSpec,
	runLaunchSpec,
	type BuildLaunchSpecInput,
	type LaunchSpec,
} from "./run-under-fence.ts";

export interface RunPiFencedDependencies {
	warn: (message: string) => void;
	resolveFencePaths: (input: { env: NodeJS.ProcessEnv }) => ResolvedFencePaths;
	ensureBootstrapConfigs: (
		paths: Pick<ResolvedFencePaths, "fenceBaseConfigPath" | "globalConfigPath">,
	) => void;
	validateFenceConfig: (configPath: string) => void;
	writeLockedSettingsFile: (input: {
		fencePaths: Pick<ResolvedFencePaths, "fenceBaseConfigPath" | "globalConfigPath">;
	}) => SelfProtectionResult;
	buildLaunchSpec: (input: BuildLaunchSpecInput) => LaunchSpec;
	runLaunchSpec: (spec: LaunchSpec) => { exitCode: number };
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
	activeSettingsPath: string;
	generatedLockedSettingsPath?: string;
	dependencies: TDependencies;
}

const DEFAULT_WARNING_PREFIX = "pi-fenced:";

function createBaseDependencies(
	overrides: Partial<RunPiFencedDependencies> | undefined,
): RunPiFencedDependencies {
	return {
		warn: (message) => console.warn(`${DEFAULT_WARNING_PREFIX} ${message}`),
		resolveFencePaths: ({ env: envValue }) => resolveFencePaths({ env: envValue }),
		ensureBootstrapConfigs,
		validateFenceConfig,
		writeLockedSettingsFile,
		buildLaunchSpec,
		runLaunchSpec,
		...overrides,
	};
}

function prepareLaunchContext<TDependencies extends RunPiFencedDependencies>(
	input: { argv: string[]; env?: NodeJS.ProcessEnv },
	dependencies: TDependencies,
): PreparedLaunchContext<TDependencies> {
	const env = input.env ?? process.env;
	const parsed = parseLauncherArguments(input.argv);
	for (const warning of parsed.warnings) {
		dependencies.warn(warning);
	}

	const paths = dependencies.resolveFencePaths({ env });
	dependencies.ensureBootstrapConfigs({
		fenceBaseConfigPath: paths.fenceBaseConfigPath,
		globalConfigPath: paths.globalConfigPath,
	});

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

	let activeSettingsPath = paths.globalConfigPath;
	let generatedLockedSettingsPath: string | undefined;
	if (!parsed.withoutFence && !parsed.allowSelfModify) {
		const lockedSettings = dependencies.writeLockedSettingsFile({
			fencePaths: {
				fenceBaseConfigPath: paths.fenceBaseConfigPath,
				globalConfigPath: paths.globalConfigPath,
			},
		});
		activeSettingsPath = lockedSettings.settingsPath;
		generatedLockedSettingsPath = lockedSettings.settingsPath;
	}

	return {
		env,
		parsed,
		paths,
		activeSettingsPath,
		generatedLockedSettingsPath,
		dependencies,
	};
}

function launchSinglePiSession(
	context: PreparedLaunchContext<RunPiFencedDependencies>,
): number {
	if (!context.parsed.withoutFence) {
		context.dependencies.validateFenceConfig(context.activeSettingsPath);
	}

	const spec = context.dependencies.buildLaunchSpec({
		withoutFence: context.parsed.withoutFence,
		fenceMonitor: context.parsed.fenceMonitor,
		configPath: context.activeSettingsPath,
		piArgs: context.parsed.piArgs,
		baseEnv: context.env,
	});

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

function shouldRestartAfterApplyOutcome(outcome: ApplyOutcome): boolean {
	return outcome.type !== "no-request";
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
		return launchSinglePiSession(context);
	} finally {
		cleanupGeneratedLockedSettingsFile(context);
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

	try {
		while (true) {
			const launchExitCode = launchSinglePiSession(context);

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
		}
	} finally {
		cleanupGeneratedLockedSettingsFile(context);
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	try {
		return await runPiFencedWithRestartLoop({ argv });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${DEFAULT_WARNING_PREFIX} ${message}`);
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
