import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../coding-agent/src/core/extensions/types.ts";
import { classifyAssistantFailure, classifyFailure } from "./classify-failure.ts";
import {
	buildSelfHealFollowUp,
	isAutoRetryFailureClass,
	shouldDeferAssistantRetryToAgentSession,
	tryProviderModelFallback,
} from "./dispatch.ts";
import { decideRetry } from "./retry-policy.ts";
import type { PendingRetry, SelfHealState } from "./state.ts";
import { getAttemptCount, recordFailureAttempt } from "./state.ts";

export interface ToolFailureInput {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function queueToolFailureRetry(
	state: SelfHealState,
	input: ToolFailureInput,
): { shouldRetry: boolean; reason: string; pending: PendingRetry | null } {
	const failureClass = classifyFailure(input);
	const attempt = getAttemptCount(state, failureClass);
	const decision = decideRetry(failureClass, attempt);

	if (!decision.shouldRetry || !isAutoRetryFailureClass(failureClass)) {
		state.pending = null;
		return { shouldRetry: false, reason: decision.reason, pending: null };
	}

	const nextAttempt = recordFailureAttempt(state, failureClass);
	const pending: PendingRetry = {
		failureClass,
		reason: `retry:${failureClass}:${nextAttempt}/${decision.maxAttempts}`,
		source: "tool",
		command: input.command,
		errorText: input.stdout || input.stderr,
	};
	state.pending = pending;
	return { shouldRetry: true, reason: pending.reason, pending };
}

function findLastAssistantError(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "error" && assistant.errorMessage) {
				return assistant;
			}
			return undefined;
		}
	}
	return undefined;
}

export async function dispatchPendingSelfHealRetry(
	pi: ExtensionAPI,
	state: SelfHealState,
	messages: AgentMessage[],
	routing: { initialPrompt?: string; turnCount: number; consecutiveFailures: number },
	ctx: {
		model: Model<any> | undefined;
		modelRegistry: { getAvailable(): Model<any>[] };
	},
): Promise<boolean> {
	let pending = state.pending;

	if (!pending) {
		const assistantError = findLastAssistantError(messages);
		if (!assistantError?.errorMessage) return false;
		if (shouldDeferAssistantRetryToAgentSession(assistantError.errorMessage)) {
			return false;
		}

		const failureClass = classifyAssistantFailure(assistantError.errorMessage);
		if (!isAutoRetryFailureClass(failureClass)) return false;

		const attempt = getAttemptCount(state, failureClass);
		const decision = decideRetry(failureClass, attempt);
		if (!decision.shouldRetry) return false;

		const nextAttempt = recordFailureAttempt(state, failureClass);
		pending = {
			failureClass,
			reason: `retry:${failureClass}:${nextAttempt}/${decision.maxAttempts}`,
			source: "assistant",
			errorText: assistantError.errorMessage,
		};
	}

	if (!isAutoRetryFailureClass(pending.failureClass)) {
		state.pending = null;
		return false;
	}

	if (pending.failureClass === "provider") {
		await tryProviderModelFallback(pi, ctx, routing);
	}

	const followUp = buildSelfHealFollowUp(pending);
	state.pending = null;
	pi.sendUserMessage(followUp, { deliverAs: "followUp" });
	return true;
}
