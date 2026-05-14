export interface ParsedLauncherArguments {
	withoutFence: boolean;
	fenceMonitor: boolean;
	allowSelfModify: boolean;
	helpRequested: boolean;
	allowMacosPasteboardPermanently: boolean;
	disallowMacosPasteboardPermanently: boolean;
	piArgs: string[];
	warnings: string[];
	presetCommand?:
		| { action: "list" }
		| { action: "current" }
		| { action: "use"; presetName: string };
}

function createDefaultParsedLauncherArguments(): ParsedLauncherArguments {
	return {
		withoutFence: false,
		fenceMonitor: false,
		allowSelfModify: false,
		helpRequested: false,
		allowMacosPasteboardPermanently: false,
		disallowMacosPasteboardPermanently: false,
		piArgs: [],
		warnings: [],
	};
}

function parsePresetCommand(argv: string[]): ParsedLauncherArguments {
	const [action, value, extra] = argv;
	if (action === "list" && value === undefined) {
		return {
			...createDefaultParsedLauncherArguments(),
			presetCommand: { action: "list" },
		};
	}

	if (action === "current" && value === undefined) {
		return {
			...createDefaultParsedLauncherArguments(),
			presetCommand: { action: "current" },
		};
	}

	if (action === "use" && typeof value === "string" && value.trim().length > 0 && extra === undefined) {
		return {
			...createDefaultParsedLauncherArguments(),
			presetCommand: { action: "use", presetName: value.trim() },
		};
	}

	throw new Error(
		"Usage: pi-fenced preset list | current | use <name>",
	);
}

export function parseLauncherArguments(argv: string[]): ParsedLauncherArguments {
	if (argv[0] === "preset") {
		return parsePresetCommand(argv.slice(1));
	}

	const parsed = createDefaultParsedLauncherArguments();
	let separatorReached = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (separatorReached) {
			parsed.piArgs.push(arg);
			continue;
		}

		if (arg === "--") {
			separatorReached = true;
			continue;
		}

		if (arg === "--help") {
			parsed.helpRequested = true;
			parsed.piArgs = [];
			break;
		}

		if (arg === "--without-fence") {
			parsed.withoutFence = true;
			continue;
		}

		if (arg === "--fence-monitor") {
			parsed.fenceMonitor = true;
			continue;
		}

		if (arg === "--allow-self-modify") {
			parsed.allowSelfModify = true;
			continue;
		}

		if (arg === "--allow-macos-pasteboard-permanently") {
			parsed.allowMacosPasteboardPermanently = true;
			continue;
		}

		if (arg === "--disallow-macos-pasteboard-permanently") {
			parsed.disallowMacosPasteboardPermanently = true;
			continue;
		}

		parsed.piArgs.push(arg);
	}

	if (
		parsed.allowMacosPasteboardPermanently &&
		parsed.disallowMacosPasteboardPermanently
	) {
		throw new Error(
			"--allow-macos-pasteboard-permanently and " +
				"--disallow-macos-pasteboard-permanently cannot be used together",
		);
	}

	if (parsed.withoutFence && parsed.fenceMonitor) {
		parsed.fenceMonitor = false;
		parsed.warnings.push("--fence-monitor ignored in --without-fence mode");
	}

	return parsed;
}
