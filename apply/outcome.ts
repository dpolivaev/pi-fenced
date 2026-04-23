export type ApplyOutcomeType =
	| "no-request"
	| "conflict-cleanup"
	| "invalid-request"
	| "base-hash-mismatch"
	| "rejected"
	| "applied"
	| "apply-failed";

export interface ApplyOutcome {
	type: ApplyOutcomeType;
	message: string;
	requestId?: string;
	removedRequestPaths?: string[];
	removedProposalPaths?: string[];
}

export function isSuccessfulOutcome(type: ApplyOutcomeType): boolean {
	return (
		type === "no-request" ||
		type === "conflict-cleanup" ||
		type === "rejected" ||
		type === "applied"
	);
}
