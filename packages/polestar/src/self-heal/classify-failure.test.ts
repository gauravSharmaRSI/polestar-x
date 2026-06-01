import { describe, expect, it } from "vitest";
import { classifyAssistantFailure, classifyFailure, type FailureInput } from "./classify-failure.ts";

describe("classifyFailure", () => {
	const defaultInput: FailureInput = {
		stdout: "",
		stderr: "",
		exitCode: 0,
		command: "",
	};

	it("classifies unsafe actions correctly", () => {
		expect(classifyFailure({ ...defaultInput, command: "rm -rf /" })).toBe("unsafe");
		expect(classifyFailure({ ...defaultInput, command: "git push -f origin main" })).toBe("unsafe");
		expect(classifyFailure({ ...defaultInput, command: "git reset --hard HEAD~1" })).toBe("unsafe");
		expect(classifyFailure({ ...defaultInput, stdout: "DROP TABLE users;" })).toBe("unsafe");

		// Case insensitivity
		expect(classifyFailure({ ...defaultInput, command: "RM -RF /" })).toBe("unsafe");
	});

	it("classifies provider errors correctly (e.g. timeout)", () => {
		expect(classifyFailure({ ...defaultInput, stderr: "ETIMEOUT: Connection timeout" })).toBe("provider");
		expect(classifyFailure({ ...defaultInput, stderr: "Rate limit exceeded" })).toBe("provider");
		expect(classifyFailure({ ...defaultInput, stdout: "Error 503 Service Unavailable" })).toBe("provider");
	});

	it("classifies infrastructure errors correctly (e.g. missing dep)", () => {
		expect(classifyFailure({ ...defaultInput, stderr: "Error: Cannot find module 'lodash'" })).toBe("infra");
		expect(classifyFailure({ ...defaultInput, stderr: "sh: vitest: command not found" })).toBe("infra");
		expect(classifyFailure({ ...defaultInput, stderr: "EACCES: permission denied" })).toBe("infra");
	});

	it("classifies test and code failures correctly", () => {
		expect(classifyFailure({ ...defaultInput, stderr: "AssertionError: expected 1 to equal 2", exitCode: 1 })).toBe(
			"code_test",
		);
		expect(classifyFailure({ ...defaultInput, stdout: "Tests failed", exitCode: 1 })).toBe("code_test");

		// Fallback to code_test when exitCode !== 0 and no other category matches
		expect(classifyFailure({ ...defaultInput, exitCode: 1, stderr: "Some random application error" })).toBe(
			"code_test",
		);
	});

	it("classifies unknown failures correctly", () => {
		expect(classifyFailure({ ...defaultInput, stdout: "Just some normal output", exitCode: 0 })).toBe("unknown");

		// Special case: if exitCode is 0 but it says "unknown" (this shouldn't really happen but for coverage)
		expect(classifyFailure({ ...defaultInput, command: "echo hello", exitCode: 0 })).toBe("unknown");
	});

	it("handles multi-line input and mixed categories with correct precedence", () => {
		// unsafe should take precedence over others
		expect(
			classifyFailure({
				...defaultInput,
				command: "npm test",
				stderr: "Failed to run tests\nrm -rf /",
				exitCode: 1,
			}),
		).toBe("unsafe");

		// provider should take precedence over infra and code_test
		expect(
			classifyFailure({
				...defaultInput,
				command: "npm install",
				stderr: "Cannot find module 'something'\nRate limit exceeded",
				exitCode: 1,
			}),
		).toBe("provider");
	});
});

describe("classifyAssistantFailure", () => {
	it("does not treat generic errors or non-zero exit heuristics as code_test", () => {
		expect(classifyAssistantFailure("authentication error: invalid API key")).toBe("unknown");
		expect(classifyAssistantFailure("billing quota exceeded")).toBe("unknown");
		expect(classifyAssistantFailure("maximum context length exceeded")).toBe("unknown");
		expect(classifyAssistantFailure("Some random application error")).toBe("unknown");
	});

	it("still classifies transient provider faults", () => {
		expect(classifyAssistantFailure("Rate limit exceeded")).toBe("provider");
		expect(classifyAssistantFailure("Error 503 Service Unavailable")).toBe("provider");
	});
});
