import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * S3 flush delivery-timing verification against the REAL pi 0.83.0
 * AgentSession (decision #39).
 *
 * Claim under test: a custom message sent via `pi.sendMessage` WITHOUT
 * options while a TOOL EXECUTION is in flight lands in the conversation
 * right AFTER the tool result and BEFORE the next assistant completion —
 * same agent run, zero streaming interruption. This is what the
 * team_send_and_wait S3 flush relies on (flushTlWaitBuffer in tl-tools.ts):
 * buffered member→TL messages become visible to the TL the moment the
 * all-idle gate opens, without waiting for the TL's turn to end.
 *
 * Only the provider transport is faked (deterministic, in-process) — the
 * AgentSession, agent loop, steering queue, and ExtensionAPI binding are
 * all production code paths from the installed package.
 */

const MODEL_CONFIG = {
  id: "s3-test-model",
  name: "S3 test model",
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 256,
};

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
}

function assistantMessage(content: any[], stopReason: string): any {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "s3-test",
    model: MODEL_CONFIG.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Scripted responses:
 *  1. assistant message containing a toolCall for `flush_probe`
 *  2. plain text completion (final)
 */
function scriptedStream(script: "tool" | "final", signal?: AbortSignal): any {
  const content =
    script === "tool"
      ? [{ type: "toolCall", id: "tc-1", name: "flush_probe", arguments: {} }]
      : [{ type: "text", text: "final answer after flush" }];
  const pending = assistantMessage(content, "pending");
  const final = assistantMessage(content, "stop");
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: pending };
      if (signal?.aborted) {
        yield { type: "error", reason: "aborted", error: final };
        return;
      }
      yield { type: "done", reason: "stop", message: final };
    },
    result: async () => final,
  };
}

describe("S3 flush delivery timing (real AgentSession)", () => {
  it("custom message sent during tool execution is injected after the tool result, in the same run", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-s3-flush-"));
    let callIndex = 0;
    const eventLog: string[] = [];
    let toolExecuted = false;

    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
      { projectTrusted: true },
    );

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "s3-flush-probe",
          factory: (pi: ExtensionAPI) => {
            pi.registerTool({
              name: "flush_probe",
              label: "Flush Probe",
              description: "Sends a custom message mid-execution, like the S3 flush.",
              parameters: { type: "object", properties: {} },
              async execute() {
                toolExecuted = true;
                // Exactly what flushTlWaitBuffer does: plain sendMessage, no
                // deliverAs options. The agent run is active (tool execution)
                // → pi takes the steer branch.
                pi.sendMessage({
                  customType: "team-message",
                  content: "[消息通道 - 来自 worker]\nS3-FLUSH-PROBE 等待期间的补充汇报",
                  display: true,
                });
                return {
                  details: {},
                  content: [{ type: "text" as const, text: "tool-result" }],
                };
              },
            });
          },
        },
      ],
    });
    await resourceLoader.reload();

    const modelRuntime = await ModelRuntime.create({
      authPath: `${agentDir}/auth.json`,
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("s3-test", {
      name: "S3 test provider",
      api: "openai-completions",
      baseUrl: "http://s3-test.invalid",
      apiKey: "in-process-test-key",
      models: [MODEL_CONFIG],
      streamSimple: (_model, _context, options) => {
        const script = callIndex++ === 0 ? "tool" : "final";
        return scriptedStream(script, options?.signal);
      },
    });
    const model = modelRuntime.getModel("s3-test", MODEL_CONFIG.id);
    if (!model) throw new Error("Failed to create fake test model");

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
    });
    session.subscribe((event: any) => {
      eventLog.push(event.type);
    });

    await session.prompt("run the probe");

    // The tool executed and the run completed normally.
    expect(toolExecuted).toBe(true);

    const messages: any[] = session.agent.state.messages;
    const roles = messages.map((m) => m.role);

    // Find the anchors.
    const toolResultIndex = messages.findIndex((m) => m.role === "toolResult");
    const customIndex = messages.findIndex(
      (m) => m.role === "custom" && String(m.content).includes("S3-FLUSH-PROBE")
    );
    const finalAssistantIndex = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === "text" && c.text.includes("final answer"))
    );

    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBeGreaterThan(toolResultIndex); // after the tool result
    expect(finalAssistantIndex).toBeGreaterThan(customIndex); // before the next completion
    // No toolCall after the injection — the final completion is plain text.
    expect(roles.filter((r) => r === "toolResult")).toHaveLength(1);

    // The steered custom message was emitted through the normal message
    // lifecycle (visible in TUI/history) — not silently appended.
    expect(eventLog).toContain("message_end");

    rmSync(agentDir, { recursive: true, force: true });
  }, 20_000);
});
