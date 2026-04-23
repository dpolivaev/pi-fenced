export interface ParsedLauncherArguments {
	withoutFence: boolean;
	fenceMonitor: boolean;
	allowSelfModify: boolean;
	piArgs: string[];
	warnings: string[];
}

export function parseLauncherArguments(argv: string[]): ParsedLauncherArguments {
	let withoutFence = false;
	let fenceMonitor = false;
	let allowSelfModify = false;
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

		piArgs.push(arg);
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
		piArgs,
		warnings,
	};
}
