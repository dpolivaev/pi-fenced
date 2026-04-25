#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxLoaderSpecifier = pathToFileURL(require.resolve("tsx")).href;
const launcherPath = fileURLToPath(new URL("../launcher/pi-fenced.ts", import.meta.url));

const child = spawn(
	process.execPath,
	["--import", tsxLoaderSpecifier, launcherPath, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: process.env,
	},
);

child.once("error", (error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`pi-fenced: failed to launch runtime: ${message}\n`);
	process.exitCode = 1;
});

child.once("exit", (code, signal) => {
	if (signal) {
		process.stderr.write(`pi-fenced: launcher terminated by signal ${signal}\n`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = code ?? 1;
});
