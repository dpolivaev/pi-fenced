export interface ParsedLauncherArguments {
	withoutFence: boolean;
	fenceMonitor: boolean;
	allowSelfModify: boolean;
	allowMacosPasteboardPermanently: boolean;
	disallowMacosPasteboardPermanently: boolean;
	piArgs: string[];
	warnings: string[];
	presetCommand?:
		| { action: "list" }
		| { action: "current" }
		| { action: "use"; presetName: string };
}

function parsePresetCommand(argv: string[]): ParsedLauncherArguments {
	const [action, value, extra] = argv;
	if (action === "list" && value === undefined) {
		return {
			withoutFence: false,
			fenceMonitor: false,
			allowSelfModify: false,
			allowMacosPasteboardPermanently: false,
			disallowMacosPasteboardPermanently: false,
			piArgs: [],
			warnings: [],
			presetCommand: { action: "list" },
		};
	}

	if (action === "current" && value === undefined) {
		return {
			withoutFence: false,
			fenceMonitor: false,
			allowSelfModify: false,
			allowMacosPasteboardPermanently: false,
			disallowMacosPasteboardPermanently: false,
			piArgs: [],
			warnings: [],
			presetCommand: { action: "current" },
		};
	}

	if (action === "use" && typeof value === "string" && value.trim().length > 0 && extra === undefined) {
		return {
			withoutFence: false,
			fenceMonitor: false,
			allowSelfModify: false,
			allowMacosPasteboardPermanently: false,
			disallowMacosPasteboardPermanently: false,
			piArgs: [],
			warnings: [],
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
	let withoutFence = false;
	let fenceMonitor = false;
	let allowSelfModify = false;
	let allowMacosPasteboardPermanently = false;
	let disallowMacosPasteboardPermanently = false;
	const piArgs: string[] = [];
	let separatorReached = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (separatorReached) {
			piArgs.push(arg);
			continue;
		}

		if (arg === "--") {
			separatorReached = true;
			continue;
		}

		if (arg === "--without-fence") {
			withoutFence = true;
			continue;
		}

		if (arg === "--fence-monitor") {
			fenceMonitor = true;
			continue;
		}

		if (arg === "--allow-self-modify") {
			allowSelfModify = true;
			continue;
		}

		if (arg === "--allow-macos-pasteboard-permanently") {
			allowMacosPasteboardPermanently = true;
			continue;
		}

		if (arg === "--disallow-macos-pasteboard-permanently") {
			disallowMacosPasteboardPermanently = true;
			continue;
		}

		piArgs.push(arg);
	}

	if (
		allowMacosPasteboardPermanently &&
		disallowMacosPasteboardPermanently
	) {
		throw new Error(
			"--allow-macos-pasteboard-permanently and " +
				"--disallow-macos-pasteboard-permanently cannot be used together",
		);
	}

	const warnings: string[] = [];
	if (withoutFence && fenceMonitor) {
		fenceMonitor = false;
		warnings.push("--fence-monitor ignored in --without-fence mode");
	}

	return {
		withoutFence,
		fenceMonitor,
		allowSelfModify,
		allowMacosPasteboardPermanently,
		disallowMacosPasteboardPermanently,
		piArgs,
		warnings,
	};
}
