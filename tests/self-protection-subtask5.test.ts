import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	buildLockedSettingsContent,
	computeProtectedWritePaths,
	pruneStaleLockedSettingsFiles,
	writeLockedSettingsFile,
} from "../launcher/self-protection.ts";

test("computeProtectedWritePaths normalizes and protects full package + active configs", () => {
	const paths = computeProtectedWritePaths({
		projectRoot: "/workspace/pi-fenced/.",
		fencePaths: {
			globalConfigPath: "/Users/test/.pi/agent/fence/../fence/global.json",
			fenceBaseConfigPath: "/Users/test/.config/fence/fence.json",
		},
	});

	assert.deepEqual(paths, [
		"/workspace/pi-fenced",
		"/Users/test/.pi/agent/fence/global.json",
		"/Users/test/.pi/agent/fence",
		"/Users/test/.config/fence/fence.json",
		"/Users/test/.config/fence",
	]);
});

test("buildLockedSettingsContent produces valid JSON with extends and denyWrite", () => {
	const content = buildLockedSettingsContent("/Users/test/.pi/agent/fence/global.json", [
		"/workspace/pi-fenced",
	]);

	const parsed = JSON.parse(content) as {
		extends: string;
		filesystem: { denyWrite: string[] };
	};
	assert.equal(parsed.extends, "/Users/test/.pi/agent/fence/global.json");
	assert.deepEqual(parsed.filesystem.denyWrite, ["/workspace/pi-fenced"]);
	assert.equal(content.endsWith("\n"), true);
});

test("writeLockedSettingsFile writes per-run launcher-locked settings file", () => {
	const writes: Array<{ path: string; content: string }> = [];
	const mkdirs: string[] = [];

	const result = writeLockedSettingsFile(
		{
			runtimeRoot: "/tmp/pi/runtime-root",
			runId: "pid-1234",
			projectRoot: "/workspace/pi-fenced",
			fencePaths: {
				globalConfigPath: "/Users/test/.pi/agent/fence/global.json",
				fenceBaseConfigPath: "/Users/test/.config/fence/fence.json",
			},
		},
		{
			mkdirSync: (pathValue) => mkdirs.push(pathValue),
			writeFileSync: (pathValue, content) => writes.push({ path: pathValue, content }),
		},
	);

	assert.equal(
		result.settingsPath,
		"/tmp/pi/runtime-root/runtime/launcher-locked-settings.pid-1234.json",
	);
	assert.equal(mkdirs.length, 1);
	assert.equal(mkdirs[0], "/tmp/pi/runtime-root/runtime");
	assert.equal(writes.length, 1);
	assert.equal(
		writes[0].path,
		"/tmp/pi/runtime-root/runtime/launcher-locked-settings.pid-1234.json",
	);

	const parsed = JSON.parse(writes[0].content) as {
		extends: string;
		filesystem: { denyWrite: string[] };
	};
	assert.equal(parsed.extends, "/Users/test/.pi/agent/fence/global.json");
	assert.deepEqual(parsed.filesystem.denyWrite, [
		"/workspace/pi-fenced",
		"/Users/test/.pi/agent/fence/global.json",
		"/Users/test/.pi/agent/fence",
		"/Users/test/.config/fence/fence.json",
		"/Users/test/.config/fence",
	]);
});

test("pruneStaleLockedSettingsFiles removes stale dead-run files only", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const runtimeRoot = mkdtempSync("/tmp/pi/pi-fenced-lock-cleanup-");
	const runtimeDir = join(runtimeRoot, "runtime");
	mkdirSync(runtimeDir, { recursive: true });

	const nowMs = Date.now();
	const staleTimestamp = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);

	const staleDeadFile = join(runtimeDir, "launcher-locked-settings.999999.olddead.json");
	const staleLiveFile = join(runtimeDir, `launcher-locked-settings.${process.pid}.oldlive.json`);
	const freshDeadFile = join(runtimeDir, "launcher-locked-settings.999999.fresh.json");
	const unrelatedFile = join(runtimeDir, "unrelated.json");

	writeFileSync(staleDeadFile, "{}\n", "utf-8");
	writeFileSync(staleLiveFile, "{}\n", "utf-8");
	writeFileSync(freshDeadFile, "{}\n", "utf-8");
	writeFileSync(unrelatedFile, "{}\n", "utf-8");

	utimesSync(staleDeadFile, staleTimestamp, staleTimestamp);
	utimesSync(staleLiveFile, staleTimestamp, staleTimestamp);

	try {
		const removed = pruneStaleLockedSettingsFiles({
			runtimeRoot,
			nowMs,
			maxAgeMs: 60 * 60 * 1000,
		});

		assert.deepEqual(removed, [staleDeadFile]);
		assert.equal(existsSync(staleDeadFile), false);
		assert.equal(existsSync(staleLiveFile), true);
		assert.equal(existsSync(freshDeadFile), true);
		assert.equal(existsSync(unrelatedFile), true);
	} finally {
		rmSync(runtimeRoot, { recursive: true, force: true });
	}
});
