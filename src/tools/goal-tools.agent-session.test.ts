import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  VERSION,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { startSession, endSession } from "../session/state";
import {
  registerGoalAgentHandler,
  resetGoal,
  setGoalForTesting,
} from "./goal-tools";

/**
 * Stage 2 integration fixture.
 *
 * The AgentSession, Agent, ExtensionRunner, ExtensionAPI binding, and
 * sendUserMessage wrapper are all from the installed pi 0.83.0 package. Only
 * the provider transport is deterministic and in-process, so these tests do
 * not require credentials or network access.
 */

type FakeResponse =
  | { kind: "stop"; text?: string }
  | { kind: "error"; text?: string; errorMessage?: string }
  | { kind: "hang"; text?: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | undefined) => void;
};

interface ApiCall {
  content: string;
  options: unknown;
  result: unknown;
}

interface HarnessState {
  streamCalls: number;
  apiCalls: ApiCall[];
  markerPrompts: string[];
  eventLog: string[];
  agentEndIdleValues: boolean[];
  agentSettledIdleValues: boolean[];
  diagnosticMessages: string[];
  forceNoAck: boolean;
  holdNextReminderAck?: Deferred<void>;
}

interface Harness {
  session: any;
  state: HarnessState;
  dispose: () => void;
}

interface HarnessOptions {
  retry?: boolean;
  contextWindow?: number;
  compaction?: {
    enabled: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    disableAfterFirst?: boolean;
  };
}

const TEAM = {
  name: "goal-agent-session-test",
  description: "",
  members: [],
};

const MODEL_CONFIG = {
  id: "goal-test-model",
  name: "Goal test model",
  api: "openai-completions" as const,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 256,
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | undefined) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = (value) => resolve(value as T);
  });
  return { promise, resolve: resolvePromise };
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for integration fixture state");
    }
    await waitFor(5);
  }
}

async function flushMicrotasks(limit = 100): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await Promise.resolve();
  }
}

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(
  text: string,
  stopReason: "pending" | "stop" | "error" | "aborted",
  errorMessage?: string,
): any {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "goal-test",
    model: MODEL_CONFIG.id,
    usage: usage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** Minimal provider stream implementing the pi-ai AssistantMessageEventStream contract. */
function responseStream(response: FakeResponse, signal?: AbortSignal): any {
  const pending = assistantMessage(response.text ?? "ok", "pending");
  let final = assistantMessage(response.text ?? "ok", "stop");
  if (response.kind === "error") {
    final = assistantMessage(response.text ?? "temporary provider failure", "error", response.errorMessage);
  }

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: pending };
      if (response.kind === "hang") {
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        final = assistantMessage(response.text ?? "aborted", "aborted");
        yield { type: "error", reason: "aborted", error: final };
        return;
      }
      if (response.kind === "error") {
        yield { type: "error", reason: "error", error: final };
      } else {
        yield { type: "done", reason: "stop", message: final };
      }
    },
    result: async () => final,
  };
}

async function createHarness(
  responses: FakeResponse[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const state: HarnessState = {
    streamCalls: 0,
    apiCalls: [],
    markerPrompts: [],
    eventLog: [],
    agentEndIdleValues: [],
    agentSettledIdleValues: [],
    diagnosticMessages: [],
    forceNoAck: false,
  };

  const settingsManager = SettingsManager.inMemory(
    {
      compaction: {
        enabled: options.compaction?.enabled ?? false,
        reserveTokens: options.compaction?.reserveTokens ?? 16_384,
        keepRecentTokens: options.compaction?.keepRecentTokens ?? 20_000,
      },
      retry: {
        enabled: options.retry ?? false,
        maxRetries: 1,
        baseDelayMs: 0,
      },
    },
    { projectTrusted: true },
  );
  const agentDir = mkdtempSync(join(tmpdir(), "pi-goal-agent-session-"));
  const modelConfig = {
    ...MODEL_CONFIG,
    contextWindow: options.contextWindow ?? MODEL_CONFIG.contextWindow,
  };
  let sessionRef: any;
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
        name: "goal-agent-session-test",
        factory: (pi: ExtensionAPI) => {
          // This handler runs before goal-tools' handler and can hold the
          // actual before_agent_start ACK to model native preflight delay.
          pi.on("before_agent_start", async (event) => {
            const prompt = (event as { prompt?: unknown }).prompt;
            if (typeof prompt !== "string" || !prompt.includes("top-notch-team:goal-reminder:")) {
              return;
            }
            state.markerPrompts.push(prompt);
            state.eventLog.push("before_agent_start:goal-reminder");
            const gate = state.holdNextReminderAck;
            state.holdNextReminderAck = undefined;
            if (gate) await gate.promise;
          });

          // ExtensionAPI.sendUserMessage is intentionally left as the real
          // pi wrapper. The proxy only records its return value and payload.
          const instrumentedPi = Object.create(pi) as ExtensionAPI;
          instrumentedPi.sendUserMessage = (content, options) => {
            const previousModel = sessionRef?.agent?.state?.model;
            if (state.forceNoAck && sessionRef) {
              // Let the real AgentSession.sendUserMessage reject during its
              // model preflight. Its ExtensionAPI wrapper still returns void,
              // but no before_agent_start marker can be emitted.
              sessionRef.agent.state.model = undefined;
            }
            let result: unknown;
            try {
              result = pi.sendUserMessage(content, options);
              state.apiCalls.push({ content: String(content), options, result });
              state.eventLog.push("api:sendUserMessage");
              return result;
            } finally {
              if (state.forceNoAck && sessionRef) {
                sessionRef.agent.state.model = previousModel;
              }
            }
          };
          instrumentedPi.sendMessage = ((message: any, options: any) => {
            state.diagnosticMessages.push(String(message?.content ?? ""));
            return pi.sendMessage(message, options);
          }) as any;
          registerGoalAgentHandler(instrumentedPi);

          // These observers are registered after goal-tools so the assertions
          // see the same ExtensionRunner ordering as production handlers.
          pi.on("agent_end", (_event, ctx) => {
            state.agentEndIdleValues.push(ctx.isIdle());
          });
          pi.on("agent_settled", (_event, ctx) => {
            state.agentSettledIdleValues.push(ctx.isIdle());
          });
          if (options.compaction?.disableAfterFirst) {
            pi.on("session_compact", () => settingsManager.setCompactionEnabled(false));
          }
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
  modelRuntime.registerProvider("goal-test", {
    name: "Goal test provider",
    api: "openai-completions",
    baseUrl: "http://goal-test.invalid",
    apiKey: "in-process-test-key",
    models: [modelConfig],
    streamSimple: (_model, context, options) => {
      const index = state.streamCalls++;
      return responseStream(responses[index] ?? { kind: "stop" }, options?.signal);
    },
  });
  const model = modelRuntime.getModel("goal-test", modelConfig.id);
  if (!model) throw new Error("Failed to create fake test model");

  const session = (
    await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      settingsManager,
      noTools: "all",
    })
  ).session;
  sessionRef = session;
  await session.bindExtensions({ mode: "print" });
  session.subscribe((event: any) => {
    state.eventLog.push(`session:${event.type}`);
  });

  return {
    session,
    state,
    dispose: () => {
      session.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

function beginGoal(): void {
  startSession(TEAM as any, { sessionId: "agent-session-test" });
  setGoalForTesting({
    text: "高保真生命周期验证",
    criteria: "- AgentSession 完全结算",
    completed: false,
  });
}

afterEach(() => {
  endSession();
  resetGoal();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("goal reminder with the installed pi 0.83.0 AgentSession", () => {
  it("pins the high-fidelity fixture to the installed pi release", () => {
    expect(VERSION).toBe("0.83.0");
  });

  it("keeps the reminder out of queued continuation and sends only after real agent_settled", async () => {
    beginGoal();
    const harness = await createHarness([
      { kind: "stop", text: "first response" },
      { kind: "stop", text: "queued continuation" },
      { kind: "stop", text: "reminder response" },
    ]);
    let queued = false;
    harness.session.agent.subscribe((event: any) => {
      if (event.type === "agent_end" && !queued) {
        queued = true;
        harness.session.agent.followUp({
          role: "user",
          content: "queued continuation",
          timestamp: Date.now(),
        });
      }
    });

    try {
      await harness.session.prompt("initial user prompt");
      expect(harness.state.apiCalls).toHaveLength(0);
      const endIndices = harness.state.eventLog.reduce<number[]>((indices, entry, index) => {
        if (entry === "session:agent_end") indices.push(index);
        return indices;
      }, []);
      const settledIndex = harness.state.eventLog.indexOf("session:agent_settled");
      expect(endIndices).toHaveLength(2);
      expect(endIndices[0]).toBeLessThan(endIndices[1]);
      expect(endIndices[1]).toBeLessThan(settledIndex);

      await waitUntil(() => harness.state.apiCalls.length === 1);
      await waitUntil(() => harness.state.streamCalls === 3 && harness.session.isIdle);
      const apiIndex = harness.state.eventLog.lastIndexOf("api:sendUserMessage");
      const markerIndex = harness.state.eventLog.indexOf("before_agent_start:goal-reminder");
      const reminderStartIndex = harness.state.eventLog.lastIndexOf("session:agent_start");
      expect(apiIndex).toBeGreaterThan(settledIndex);
      expect(markerIndex).toBeGreaterThan(apiIndex);
      expect(markerIndex).toBeLessThan(reminderStartIndex);
      expect(harness.state.apiCalls[0].result).toBeUndefined();
      expect(harness.state.apiCalls[0].options).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(1);
      expect(harness.state.markerPrompts[0]).toContain("top-notch-team:goal-reminder:");
      expect(harness.state.agentEndIdleValues.every((value) => value === false)).toBe(true);
      expect(harness.state.agentSettledIdleValues).toEqual([true, true]);

      await harness.session.waitForIdle();
    } finally {
      harness.dispose();
    }
  });

  it("holds the reminder through real AgentSession auto-compaction before settled", async () => {
    beginGoal();
    const harness = await createHarness(
      [
        { kind: "stop", text: "initial response" },
        { kind: "stop", text: "compaction summary" },
        { kind: "stop", text: "compaction reminder response" },
      ],
      {
        contextWindow: 1,
        compaction: {
          enabled: true,
          reserveTokens: 0,
          keepRecentTokens: 1,
          // Keep the assertion focused on the post-run compaction that follows
          // the initial answer; a one-token test model would otherwise compact
          // the reminder response as well.
          disableAfterFirst: true,
        },
      },
    );

    try {
      await harness.session.prompt("initial user prompt");
      expect(harness.state.apiCalls).toHaveLength(0);
      const compactionStartIndex = harness.state.eventLog.indexOf("session:compaction_start");
      const compactionEndIndex = harness.state.eventLog.indexOf("session:compaction_end");
      const settledIndex = harness.state.eventLog.indexOf("session:agent_settled");
      expect(compactionStartIndex).toBeGreaterThan(-1);
      expect(compactionEndIndex).toBeGreaterThan(compactionStartIndex);
      expect(compactionEndIndex).toBeLessThan(settledIndex);

      await waitUntil(() => harness.state.apiCalls.length === 1);
      await waitUntil(() => harness.state.streamCalls === 3 && harness.session.isIdle);
      const apiIndex = harness.state.eventLog.lastIndexOf("api:sendUserMessage");
      expect(apiIndex).toBeGreaterThan(settledIndex);
      expect(harness.state.apiCalls[0].result).toBeUndefined();
      expect(harness.state.apiCalls[0].options).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(1);
      expect(harness.state.agentEndIdleValues.every((value) => value === false)).toBe(true);
      expect(harness.state.agentSettledIdleValues).toEqual([true, true]);
    } finally {
      harness.dispose();
    }
  });

  it("holds the reminder through AgentSession post-run auto-retry", async () => {
    beginGoal();
    const harness = await createHarness(
      [
        { kind: "error", text: "temporary failure", errorMessage: "429 Too Many Requests" },
        { kind: "stop", text: "retry success" },
        { kind: "stop", text: "retry reminder response" },
      ],
      { retry: true },
    );

    try {
      await harness.session.prompt("initial user prompt");
      expect(harness.state.apiCalls).toHaveLength(0);
      const retryIndex = harness.state.eventLog.indexOf("session:auto_retry_start");
      const endIndices = harness.state.eventLog.reduce<number[]>((indices, entry, index) => {
        if (entry === "session:agent_end") indices.push(index);
        return indices;
      }, []);
      const settledIndex = harness.state.eventLog.indexOf("session:agent_settled");
      expect(retryIndex).toBeGreaterThan(-1);
      expect(endIndices).toHaveLength(2);
      expect(endIndices[0]).toBeLessThan(retryIndex);
      expect(retryIndex).toBeLessThan(endIndices[1]);
      expect(endIndices[1]).toBeLessThan(settledIndex);
      await waitUntil(() => harness.state.apiCalls.length === 1);
      await waitUntil(() => harness.state.streamCalls === 3 && harness.session.isIdle);
      expect(harness.state.apiCalls[0].result).toBeUndefined();
      expect(harness.state.apiCalls[0].options).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(1);
      expect(harness.state.agentEndIdleValues.every((value) => value === false)).toBe(true);
      expect(harness.state.agentSettledIdleValues).toEqual([true, true]);
    } finally {
      harness.dispose();
    }
  });

  it("uses the real void wrapper and delayed marker ACK without duplicate submission after cooldown", async () => {
    vi.useFakeTimers();
    beginGoal();
    const harness = await createHarness([
      { kind: "stop", text: "initial response" },
      { kind: "stop", text: "delayed reminder response" },
      { kind: "stop", text: "fresh response" },
      { kind: "stop", text: "second reminder response" },
    ]);
    const ackGate = deferred<void>();
    harness.state.holdNextReminderAck = ackGate;

    try {
      await harness.session.prompt("initial user prompt");
      // The timer is the only re-entry delay in goal-tools. Advance past both
      // it and the one-second diagnostic watchdog while the native preflight
      // is held before before_agent_start.
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);
      expect(harness.state.apiCalls[0].result).toBeUndefined();
      expect(harness.state.apiCalls[0].options).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(harness.state.apiCalls).toHaveLength(1);

      // Release the real before_agent_start handler. AgentSession then starts
      // the reminder run, and its own settled boundary must not resubmit it.
      ackGate.resolve(undefined);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
      expect(harness.state.streamCalls).toBe(2);
      // Flush the reminder run's own settled timer explicitly. A missing ACK
      // would leave its candidate eligible and produce a second API call here.
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);

      // A subsequent ordinary settled run is beyond the original API
      // submission's cooldown. If ACK had refreshed lastReminder, this would
      // remain suppressed; API-only anchoring permits the second reminder.
      await harness.session.prompt("fresh user prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(2);
      expect(harness.state.apiCalls[1].result).toBeUndefined();
      expect(harness.state.apiCalls[1].options).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(2);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
      expect(harness.state.streamCalls).toBe(4);
    } finally {
      harness.dispose();
    }
  });

  it("keeps a real void submission uncertain after no ACK and ignores an isolated agent_start", async () => {
    vi.useFakeTimers();
    beginGoal();
    const harness = await createHarness([
      { kind: "stop", text: "initial response" },
      { kind: "stop", text: "later response" },
    ]);

    try {
      await harness.session.prompt("initial user prompt");
      harness.state.forceNoAck = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);
      expect(harness.state.apiCalls[0].result).toBeUndefined();
      expect(harness.state.markerPrompts).toHaveLength(0);

      // The real wrapper's underlying prompt rejects before
      // before_agent_start because the fixture temporarily removes the model.
      // The goal handler can only observe void, so the watchdog must diagnose
      // and retain uncertainty rather than retrying.
      await vi.advanceTimersByTimeAsync(1_001);
      harness.state.forceNoAck = false;
      expect(harness.state.diagnosticMessages.some((message) => message.includes("目标提醒未确认"))).toBe(true);

      // This is an actual ExtensionRunner event with no prompt payload. It is
      // deliberately isolated from a user prompt and must not ACK uncertainty.
      await harness.session.extensionRunner.emit({ type: "agent_start" } as any);
      await harness.session.prompt("later user prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);
      expect(harness.state.markerPrompts).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it("invalidates an old marker/run across a real session rollover", async () => {
    vi.useFakeTimers();
    beginGoal();
    const harness = await createHarness([
      { kind: "stop", text: "old session response" },
      { kind: "stop", text: "old reminder response" },
      { kind: "stop", text: "new session response" },
      { kind: "stop", text: "new reminder response" },
    ]);
    const oldAckGate = deferred<void>();

    try {
      await harness.session.prompt("old session prompt");
      harness.state.holdNextReminderAck = oldAckGate;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);
      const oldMarkerPrompt = harness.state.markerPrompts[0];
      expect(oldMarkerPrompt).toContain("top-notch-team:goal-reminder:");

      // Mirror teardown.ts exactly: stop the session first, then reset goal,
      // and only afterwards start the replacement session.
      endSession();
      resetGoal();
      startSession(TEAM as any, { sessionId: "agent-session-test-new" });
      setGoalForTesting({
        text: "新会话目标",
        criteria: "- 新会话完成",
        completed: false,
      });
      oldAckGate.resolve(undefined);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      // The old accepted prompt may finish its host run, but it must not be
      // reinterpreted as a candidate for the replacement session/goal.
      expect(harness.state.apiCalls).toHaveLength(1);

      await harness.session.prompt("new session prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(2);
      expect(harness.state.apiCalls[1].content).toContain("新会话目标");
      expect(harness.state.apiCalls[1].content).not.toContain("高保真生命周期验证");
      expect(harness.state.markerPrompts).toHaveLength(2);
      expect(harness.state.markerPrompts[1]).not.toBe(oldMarkerPrompt);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("invalidates an accepted marker across same-session goal replacement", async () => {
    vi.useFakeTimers();
    beginGoal();
    const harness = await createHarness([
      { kind: "stop", text: "old goal response" },
      { kind: "stop", text: "old reminder response" },
      { kind: "stop", text: "new goal response" },
      { kind: "stop", text: "new reminder response" },
    ]);
    const oldAckGate = deferred<void>();

    try {
      await harness.session.prompt("old goal prompt");
      harness.state.holdNextReminderAck = oldAckGate;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);
      const oldMarkerPrompt = harness.state.markerPrompts[0];
      expect(oldMarkerPrompt).toContain("top-notch-team:goal-reminder:");

      // No session key changes here. resetGoal/setGoalForTesting still form a
      // goal-generation rollover while the old accepted prompt is in native
      // before_agent_start preflight.
      resetGoal();
      setGoalForTesting({
        text: "同会话替换目标",
        criteria: "- 替换目标完成",
        completed: false,
      });
      oldAckGate.resolve(undefined);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(1);

      await harness.session.prompt("new goal prompt");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.state.apiCalls).toHaveLength(2);
      expect(harness.state.apiCalls[1].content).toContain("同会话替换目标");
      expect(harness.state.apiCalls[1].content).not.toContain("高保真生命周期验证");
      expect(harness.state.markerPrompts).toHaveLength(2);
      expect(harness.state.markerPrompts[0]).toBe(oldMarkerPrompt);
      expect(harness.state.markerPrompts[1]).not.toBe(oldMarkerPrompt);
      await flushMicrotasks();
      expect(harness.session.isIdle).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("does not create a stale reminder across a real abort and then accepts a fresh run", async () => {
    beginGoal();
    const harness = await createHarness([
      { kind: "hang", text: "aborted response" },
      { kind: "stop", text: "fresh response" },
      { kind: "stop", text: "fresh reminder response" },
    ]);

    try {
      const pendingPrompt = harness.session.prompt("prompt to abort");
      await waitUntil(() => harness.state.streamCalls === 1);
      expect(harness.session.isIdle).toBe(false);
      await harness.session.abort();
      await pendingPrompt;
      expect(harness.session.isIdle).toBe(true);
      await waitFor(0);
      expect(harness.state.apiCalls).toHaveLength(0);
      expect(harness.state.agentEndIdleValues).toEqual([false]);
      expect(harness.state.agentSettledIdleValues).toEqual([true]);

      await harness.session.prompt("fresh prompt after abort");
      await waitUntil(() => harness.state.apiCalls.length === 1);
      await waitUntil(() => harness.state.streamCalls === 3 && harness.session.isIdle);
      expect(harness.state.apiCalls[0].content).toContain("目标提醒");
      await harness.session.waitForIdle();
    } finally {
      harness.dispose();
    }
  });

  it("rejects an old run after reset and goal replacement, then reminds for the new goal", async () => {
    beginGoal();
    const harness = await createHarness([
      { kind: "hang", text: "stale response" },
      { kind: "stop", text: "new goal response" },
      { kind: "stop", text: "new goal reminder response" },
    ]);

    try {
      const pendingPrompt = harness.session.prompt("stale prompt");
      await waitUntil(() => harness.state.streamCalls === 1);
      resetGoal();
      setGoalForTesting({
        text: "替换后的目标",
        criteria: "- 新目标完成",
        completed: false,
      });
      await harness.session.abort();
      await pendingPrompt;
      expect(harness.state.apiCalls).toHaveLength(0);

      await harness.session.prompt("new goal prompt");
      await waitUntil(() => harness.state.apiCalls.length === 1);
      await waitUntil(() => harness.state.streamCalls === 3 && harness.session.isIdle);
      expect(harness.state.apiCalls[0].content).toContain("替换后的目标");
      expect(harness.state.apiCalls[0].content).not.toContain("高保真生命周期验证");
      await harness.session.waitForIdle();
    } finally {
      harness.dispose();
    }
  });
});
