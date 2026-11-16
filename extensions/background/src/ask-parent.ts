/**
 * The child's ask_parent tool: emits QuestionAsked and blocks until the
 * parent answers through `answer()`, the call is aborted, or the session
 * closes. Shared by the in-process backend and the hc child reporter.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Emit } from "./backends/pi-events.ts";

interface PendingAnswer {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export function createParentQuestions(emit: Emit, extraGuidelines: ReadonlyArray<string> = []) {
  const pending = new Map<string, PendingAnswer>();
  let counter = 0;
  let closed = false;

  const tool = defineTool({
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask the parent agent for clarification, missing context, or a decision, then wait for its response. Use your judgment: resolve meaningful ambiguities rather than guessing.",
    promptSnippet: "Ask the parent agent for clarification, missing context, or a decision, then wait for its answer",
    promptGuidelines: [
      "Ask the parent when clarification, missing context, or a decision could improve the result. Proceed independently for routine details, but prefer resolving meaningful ambiguities over guessing.",
      ...extraGuidelines,
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The specific question the parent agent should answer",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      if (closed) throw new Error("The parent session is no longer available.");
      const id = `q-${++counter}`;
      const answer = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          if (!pending.delete(id)) return;
          emit({ _tag: "QuestionClosed", questionId: id });
          reject(new Error("Parent question was cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          resolve,
          reject,
          removeAbortListener: () => signal?.removeEventListener("abort", abort),
        });
        if (signal?.aborted) {
          abort();
          return;
        }
        emit({ _tag: "QuestionAsked", question: { id, text: params.question } });
      });
      return {
        content: [{ type: "text", text: `Parent response: ${answer}` }],
        details: { question: params.question, answer },
      };
    },
  });

  return {
    tool,
    /** Resolve a pending question; false when it is no longer pending. */
    answer(id: string, text: string): boolean {
      const entry = pending.get(id);
      if (!entry || closed) return false;
      pending.delete(id);
      entry.removeAbortListener();
      emit({ _tag: "QuestionClosed", questionId: id });
      entry.resolve(text);
      return true;
    },
    close() {
      closed = true;
      for (const entry of pending.values()) {
        entry.removeAbortListener();
        entry.reject(new Error("Subagent session closed before the parent answered."));
      }
      pending.clear();
    },
  };
}
