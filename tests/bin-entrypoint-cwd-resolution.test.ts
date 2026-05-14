import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("bin/pi-fenced.js resolves tsx loader when launched from external cwd", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const tempRoot = mkdtempSync("/tmp/pi/pi-fenced-bin-cwd-");
	const fakeHomeDir = join(tempRoot, "home");
	const externalCwd = join(tempRoot, "external-cwd");
	const binPath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../bin/pi-fenced.js",
	);

	mkdirSync(fakeHomeDir, { recursive: true });
	mkdirSync(externalCwd, { recursive: true });

	try {
		const result = spawnSync(
			process.execPath,
			[binPath, "--without-fence"],
			{
				cwd: externalCwd,
				env: {
					...process.env,
					HOME: fakeHomeDir,
					PI_CODING_AGENT_DIR: join(fakeHomeDir, ".pi", "agent"),
				},
				encoding: "utf-8",
			},
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /--without-fence requires --allow-self-modify/);
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
		assert.doesNotMatch(result.stderr, /Cannot find package 'tsx'/);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("bin/pi-fenced.js --help prints launcher help and then pi help", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const tempRoot = mkdtempSync("/tmp/pi/pi-fenced-bin-help-");
	const fakeHomeDir = join(tempRoot, "home");
	const externalCwd = join(tempRoot, "external-cwd");
	const stubBinDir = join(tempRoot, "bin");
	const piStubPath = join(stubBinDir, "pi");
	const binPath = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../bin/pi-fenced.js",
	);

	mkdirSync(fakeHomeDir, { recursive: true });
	mkdirSync(externalCwd, { recursive: true });
	mkdirSync(stubBinDir, { recursive: true });
	writeFileSync(piStubPath, "#!/bin/sh\necho 'stub pi help'\n", "utf-8");
	chmodSync(piStubPath, 0o755);

	try {
		const result = spawnSync(process.execPath, [binPath, "--help"], {
			cwd: externalCwd,
			env: {
				...process.env,
				HOME: fakeHomeDir,
				PATH: stubBinDir,
				PI_CODING_AGENT_DIR: join(fakeHomeDir, ".pi", "agent"),
			},
			encoding: "utf-8",
		});

		assert.equal(result.status, 0);
		assert.match(result.stdout, /pi-fenced - PI launcher for Fence-managed sessions/);
		assert.match(result.stdout, /stub pi help/);
		assert.doesNotMatch(result.stdout, /sandbox_apply/);
		assert.equal(result.stderr, "");
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
