import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AtomicApplyInput {
	targetPath: string;
	proposalContent: string;
	requestId: string;
	backupsDir: string;
	validateFenceConfig: (configPath: string) => void;
}

export interface AtomicApplyResult {
	backupPath?: string;
	backupMissingMarkerPath?: string;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function applyReplaceWithRollback(input: AtomicApplyInput): AtomicApplyResult {
	const backupDir = join(input.backupsDir, input.requestId);
	mkdirSync(backupDir, { recursive: true });

	const backupPath = join(backupDir, "target.before.json");
	const backupMissingMarkerPath = join(backupDir, "target.missing");

	const targetExists = existsSync(input.targetPath);
	const originalContent = targetExists ? readFileSync(input.targetPath, "utf-8") : undefined;

	if (originalContent !== undefined) {
		writeFileSync(backupPath, originalContent, "utf-8");
	} else {
		writeFileSync(backupMissingMarkerPath, "missing\n", "utf-8");
	}

	mkdirSync(dirname(input.targetPath), { recursive: true });

	const tempPath = `${input.targetPath}.pi-fenced-apply-${process.pid}-${Date.now()}.tmp`;
	let replacedTarget = false;

	try {
		writeFileSync(tempPath, input.proposalContent, "utf-8");
		renameSync(tempPath, input.targetPath);
		replacedTarget = true;
		input.validateFenceConfig(input.targetPath);

		return {
			backupPath: originalContent !== undefined ? backupPath : undefined,
			backupMissingMarkerPath: originalContent === undefined ? backupMissingMarkerPath : undefined,
		};
	} catch (error) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}

		if (replacedTarget) {
			try {
				if (originalContent !== undefined) {
					writeFileSync(input.targetPath, originalContent, "utf-8");
				} else if (existsSync(input.targetPath)) {
					unlinkSync(input.targetPath);
				}
			} catch (rollbackError) {
				throw new Error(
					`Apply failed and rollback also failed. ` +
						`applyError=${toErrorMessage(error)}; rollbackError=${toErrorMessage(rollbackError)}`,
				);
			}
		}

		throw new Error(`Apply failed and was rolled back: ${toErrorMessage(error)}`);
	}
}
