export type FailureClass = "code_test" | "infra" | "unsafe" | "provider" | "unknown";

export interface FailureInput {
	stdout: string;
	stderr: string;
	exitCode: number;
	command: string;
}

export function classifyFailure(input: FailureInput): FailureClass {
	const blob = `${input.command}\n${input.stdout}\n${input.stderr}`.toLowerCase();
	if (/rm\s+-rf|push\s+-f|reset\s+--hard|drop\s+table/.test(blob)) {
		return "unsafe";
	}
	if (/econnrefused|rate limit|429|503|timeout|provider/.test(blob)) {
		return "provider";
	}
	if (/enoent|command not found|permission denied|cannot find module/.test(blob)) {
		return "infra";
	}
	if (/error|failed|assert|expect\(|eslint|tsc|vitest|jest/.test(blob) || input.exitCode !== 0) {
		return "code_test";
	}
	return "unknown";
}

/** Classify assistant/API errors without bash exit-code heuristics. */
export function classifyAssistantFailure(errorMessage: string): FailureClass {
	const failureClass = classifyFailure({
		command: "",
		stdout: errorMessage,
		stderr: "",
		exitCode: 0,
	});
	if (failureClass === "code_test") {
		return "unknown";
	}
	return failureClass;
}
