import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	readLauncherPreferences,
	writeLauncherPreferences,
} from "../launcher/preferences.ts";

test("readLauncherPreferences defaults when file is missing", () => {
	assert.deepEqual(readLauncherPreferences("/tmp/pi/nonexistent-preferences.json"), {
		allowMacosPasteboard: false,
	});
});

test("writeLauncherPreferences persists allowMacosPasteboard", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const root = mkdtempSync("/tmp/pi/pi-fenced-preferences-");
	const preferencesPath = join(root, "preferences.json");

	try {
		writeLauncherPreferences(preferencesPath, {
			allowMacosPasteboard: true,
		});

		assert.deepEqual(readLauncherPreferences(preferencesPath), {
			allowMacosPasteboard: true,
		});
		assert.equal(
			readFileSync(preferencesPath, "utf-8"),
			'{\n  "allowMacosPasteboard": true\n}\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeLauncherPreferences persists explicit false value", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const root = mkdtempSync("/tmp/pi/pi-fenced-preferences-false-");
	const preferencesPath = join(root, "preferences.json");

	try {
		writeLauncherPreferences(preferencesPath, {
			allowMacosPasteboard: false,
		});

		assert.deepEqual(readLauncherPreferences(preferencesPath), {
			allowMacosPasteboard: false,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readLauncherPreferences rejects invalid json", () => {
	mkdirSync("/tmp/pi", { recursive: true });
	const root = mkdtempSync("/tmp/pi/pi-fenced-preferences-invalid-");
	const preferencesPath = join(root, "preferences.json");

	try {
		writeFileSync(preferencesPath, "{not-json}\n", "utf-8");
		assert.throws(
			() => readLauncherPreferences(preferencesPath),
			/bad JSON/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

