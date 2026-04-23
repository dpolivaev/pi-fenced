import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { runPiFencedApply } from "../apply/pi-fenced-apply.ts";

interface TestPaths {
	rootDir: string;
	runtimeDir: string;
	controlDir: string;
	proposalsDir: string;
	backupsDir: string;
	agentDir: string;
	targetPath: string;
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function createTestPaths(): TestPaths {
	mkdirSync("/tmp/pi", { recursive: true });
	const rootDir = mkdtempSync("/tmp/pi/pi-fenced-apply-");
	const runtimeDir = join(rootDir, "runtime");
	const controlDir = join(runtimeDir, "control");
	const proposalsDir = join(runtimeDir, "proposals");
	const backupsDir = join(runtimeDir, "backups");
	const agentDir = join(rootDir, "agent");
	const targetPath = join(agentDir, "fence", "global.json");

	mkdirSync(controlDir, { recursive: true });
	mkdirSync(proposalsDir, { recursive: true });
	mkdirSync(backupsDir, { recursive: true });
	mkdirSync(dirname(targetPath), { recursive: true });

	return {
		rootDir,
		runtimeDir,
		controlDir,
		proposalsDir,
		backupsDir,
		agentDir,
		targetPath,
	};
}

function writeValidRequest(input: {
	requestPath: string;
	requestId: string;
	targetPath: string;
	proposalPath: string;
	baseSha256: string;
}): void {
	const request = {
		version: 1,
		requestId: input.requestId,
		createdAt: "2026-04-22T00:00:00.000Z",
		scope: "global",
		targetPath: input.targetPath,
		proposalPath: input.proposalPath,
		mutationType: "replace",
		baseSha256: input.baseSha256,
		requestedBy: "pi-fenced-extension",
		summary: "test summary",
	};
	writeFileSync(input.requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf-8");
}

function cleanup(paths: TestPaths): void {
	rmSync(paths.rootDir, { recursive: true, force: true });
}

test("runPiFencedApply rejects invalid request schema and cleans linked files", async () => {
	const paths = createTestPaths();
	try {
		const requestPath = join(paths.controlDir, "request-bad.json");
		const linkedProposalPath = join(paths.proposalsDir, "bad.json");

		writeFileSync(requestPath, '{"version":1}\n', "utf-8");
		writeFileSync(linkedProposalPath, '{"network":{}}\n', "utf-8");

		let promptCalls = 0;
		const outcome = await runPiFencedApply({
			env: { PI_CODING_AGENT_DIR: paths.agentDir },
			paths,
			dependencies: {
				validateFenceConfig: () => {},
				promptDecision: async () => {
					promptCalls += 1;
					return "reject";
				},
				print: () => {},
				warn: () => {},
			},
		});

		assert.equal(outcome.type, "invalid-request");
		assert.equal(promptCalls, 0);
		assert.equal(existsSync(requestPath), false);
		assert.equal(existsSync(linkedProposalPath), false);
	} finally {
		cleanup(paths);
	}
});

test("runPiFencedApply rejects stale base hash before prompting", async () => {
	const paths = createTestPaths();
	try {
		const currentContent = '{"network":{"allow":["localhost"]}}\n';
		const proposalContent = '{"network":{"allow":["localhost","api.example.com"]}}\n';
		const requestId = randomUUID();
		const requestPath = join(paths.controlDir, `request-${requestId}.json`);
		const proposalPath = join(paths.proposalsDir, `${requestId}.json`);

		writeFileSync(paths.targetPath, currentContent, "utf-8");
		writeFileSync(proposalPath, proposalContent, "utf-8");
		writeValidRequest({
			requestPath,
			requestId,
			targetPath: paths.targetPath,
			proposalPath,
			baseSha256: sha256('{"different":true}\n'),
		});

		let promptCalls = 0;
		const outcome = await runPiFencedApply({
			env: { PI_CODING_AGENT_DIR: paths.agentDir },
			paths,
			dependencies: {
				validateFenceConfig: () => {},
				promptDecision: async () => {
					promptCalls += 1;
					return "apply";
				},
				print: () => {},
				warn: () => {},
			},
		});

		assert.equal(outcome.type, "base-hash-mismatch");
		assert.equal(promptCalls, 0);
		assert.equal(readFileSync(paths.targetPath, "utf-8"), currentContent);
		assert.equal(existsSync(requestPath), false);
		assert.equal(existsSync(proposalPath), false);
	} finally {
		cleanup(paths);
	}
});

test("runPiFencedApply applies request, validates, and writes backup", async () => {
	const paths = createTestPaths();
	try {
		const currentContent = '{"network":{"allow":["localhost"]}}\n';
		const proposalContent = '{"network":{"allow":["localhost","api.example.com"]}}\n';
		const requestId = randomUUID();
		const requestPath = join(paths.controlDir, `request-${requestId}.json`);
		const proposalPath = join(paths.proposalsDir, `${requestId}.json`);

		writeFileSync(paths.targetPath, currentContent, "utf-8");
		writeFileSync(proposalPath, proposalContent, "utf-8");
		writeValidRequest({
			requestPath,
			requestId,
			targetPath: paths.targetPath,
			proposalPath,
			baseSha256: sha256(currentContent),
		});

		const printed: string[] = [];
		const validated: string[] = [];
		const outcome = await runPiFencedApply({
			env: { PI_CODING_AGENT_DIR: paths.agentDir },
			paths,
			dependencies: {
				validateFenceConfig: (pathValue) => {
					validated.push(pathValue);
				},
				promptDecision: async () => "apply",
				print: (message) => {
					printed.push(message);
				},
				warn: () => {},
			},
		});

		assert.equal(outcome.type, "applied");
		assert.equal(readFileSync(paths.targetPath, "utf-8"), proposalContent);
		assert.deepEqual(validated, [proposalPath, paths.targetPath]);
		assert.equal(printed.length, 1);
		assert.match(printed[0], /^--- /);
		assert.match(printed[0], /^\+\+\+ /m);
		const backupPath = join(paths.backupsDir, requestId, "target.before.json");
		assert.equal(readFileSync(backupPath, "utf-8"), currentContent);
		assert.equal(existsSync(requestPath), false);
		assert.equal(existsSync(proposalPath), false);
	} finally {
		cleanup(paths);
	}
});

test("runPiFencedApply rolls back target when apply validation fails", async () => {
	const paths = createTestPaths();
	try {
		const currentContent = '{"network":{"allow":["localhost"]}}\n';
		const proposalContent = '{"network":{"allow":["invalid"]}}\n';
		const requestId = randomUUID();
		const requestPath = join(paths.controlDir, `request-${requestId}.json`);
		const proposalPath = join(paths.proposalsDir, `${requestId}.json`);

		writeFileSync(paths.targetPath, currentContent, "utf-8");
		writeFileSync(proposalPath, proposalContent, "utf-8");
		writeValidRequest({
			requestPath,
			requestId,
			targetPath: paths.targetPath,
			proposalPath,
			baseSha256: sha256(currentContent),
		});

		const outcome = await runPiFencedApply({
			env: { PI_CODING_AGENT_DIR: paths.agentDir },
			paths,
			dependencies: {
				validateFenceConfig: (pathValue) => {
					if (pathValue === paths.targetPath) {
						throw new Error("target validation failed");
					}
				},
				promptDecision: async () => "apply",
				print: () => {},
				warn: () => {},
			},
		});

		assert.equal(outcome.type, "apply-failed");
		assert.equal(readFileSync(paths.targetPath, "utf-8"), currentContent);
		const backupPath = join(paths.backupsDir, requestId, "target.before.json");
		assert.equal(readFileSync(backupPath, "utf-8"), currentContent);
		assert.equal(existsSync(requestPath), false);
		assert.equal(existsSync(proposalPath), false);
	} finally {
		cleanup(paths);
	}
});

test("runPiFencedApply drops all pending requests and linked proposals on conflict", async () => {
	const paths = createTestPaths();
	try {
		const requestIdA = "a";
		const requestIdB = "b";
		const requestAPath = join(paths.controlDir, `request-${requestIdA}.json`);
		const requestBPath = join(paths.controlDir, `request-${requestIdB}.json`);
		const derivedProposalA = join(paths.proposalsDir, `${requestIdA}.json`);
		const derivedProposalB = join(paths.proposalsDir, `${requestIdB}.json`);
		const customProposalA = join(paths.rootDir, "custom-a.json");

		writeFileSync(derivedProposalA, '{"allow":["a"]}\n', "utf-8");
		writeFileSync(derivedProposalB, '{"allow":["b"]}\n', "utf-8");
		writeFileSync(customProposalA, '{"allow":["custom-a"]}\n', "utf-8");

		writeValidRequest({
			requestPath: requestAPath,
			requestId: requestIdA,
			targetPath: paths.targetPath,
			proposalPath: customProposalA,
			baseSha256: sha256(""),
		});
		writeFileSync(requestBPath, "{this-is-not-json}\n", "utf-8");

		let promptCalls = 0;
		const warnings: string[] = [];
		const outcome = await runPiFencedApply({
			env: { PI_CODING_AGENT_DIR: paths.agentDir },
			paths,
			dependencies: {
				validateFenceConfig: () => {},
				promptDecision: async () => {
					promptCalls += 1;
					return "apply";
				},
				print: () => {},
				warn: (message) => warnings.push(message),
			},
		});

		assert.equal(outcome.type, "conflict-cleanup");
		assert.equal(promptCalls, 0);
		assert.equal(existsSync(requestAPath), false);
		assert.equal(existsSync(requestBPath), false);
		assert.equal(existsSync(derivedProposalA), false);
		assert.equal(existsSync(derivedProposalB), false);
		assert.equal(existsSync(customProposalA), false);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Detected 2 pending requests/);
	} finally {
		cleanup(paths);
	}
});
