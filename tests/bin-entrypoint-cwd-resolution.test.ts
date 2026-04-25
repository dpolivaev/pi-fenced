import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
