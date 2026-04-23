import { isAbsolute } from "node:path";

export type RequestScope = "session" | "workspace" | "global";

export interface FenceConfigApplyRequest {
	version: 1;
	requestId: string;
	createdAt: string;
	scope: RequestScope;
	targetPath: string;
	proposalPath: string;
	mutationType: "replace";
	baseSha256: string;
	requestedBy: "pi-fenced-extension";
	summary: string;
}

function expectObject(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid request field: ${fieldName}`);
	}
	return value;
}

function expectAbsolutePath(value: unknown, fieldName: string): string {
	const pathValue = expectString(value, fieldName);
	if (!isAbsolute(pathValue)) {
		throw new Error(`Invalid request field: ${fieldName} must be an absolute path`);
	}
	return pathValue;
}

export function parseFenceConfigApplyRequest(rawContent: string): FenceConfigApplyRequest {
	let parsedValue: unknown;
	try {
		parsedValue = JSON.parse(rawContent);
	} catch (error) {
		throw new Error(
			`Request file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const parsed = expectObject(parsedValue, "Request file");

	if (parsed.version !== 1) {
		throw new Error("Invalid request field: version must be 1");
	}

	const scopeValue = expectString(parsed.scope, "scope").trim();
	if (scopeValue !== "session" && scopeValue !== "workspace" && scopeValue !== "global") {
		throw new Error("Invalid request field: scope must be session, workspace, or global");
	}

	const mutationType = expectString(parsed.mutationType, "mutationType").trim();
	if (mutationType !== "replace") {
		throw new Error("Invalid request field: mutationType must be replace");
	}

	const baseSha256 = expectString(parsed.baseSha256, "baseSha256").trim();
	if (!/^[a-fA-F0-9]{64}$/.test(baseSha256)) {
		throw new Error("Invalid request field: baseSha256 must be 64 hex chars");
	}

	const requestedBy = expectString(parsed.requestedBy, "requestedBy").trim();
	if (requestedBy !== "pi-fenced-extension") {
		throw new Error('Invalid request field: requestedBy must be "pi-fenced-extension"');
	}

	const createdAt = expectString(parsed.createdAt, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new Error("Invalid request field: createdAt must be ISO-8601");
	}

	return {
		version: 1,
		requestId: expectString(parsed.requestId, "requestId").trim(),
		createdAt,
		scope: scopeValue,
		targetPath: expectAbsolutePath(parsed.targetPath, "targetPath"),
		proposalPath: expectAbsolutePath(parsed.proposalPath, "proposalPath"),
		mutationType: "replace",
		baseSha256,
		requestedBy: "pi-fenced-extension",
		summary: expectString(parsed.summary, "summary"),
	};
}
