import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createMockContext } from "./test/fixtures/mock-extension-api";
import { endSession } from "./session/state";
import { writeTeam } from "./team/store";

/**
 * Request-level assertion for the session entry notice (stage 1, acceptance 10).
 *
 * The unit tests pin our decision logic and return shape against a mocked
 * ExtensionAPI. What they cannot prove is what pi actually does with it: the
 * notice has to appear in the OUTBOUND REQUEST as a custom message positioned
 * AFTER the user's message (closest position to generation, mapped to the user
 * role), and it has to be persisted as a `custom_message` session entry so
 * later turns can point at the switch. A mocked pi would just echo back
 * whatever we returned.
 *
 * The harness is the real installed AgentSession + ExtensionRunner; only the
 * provider transport is deterministic and in-process, so no credentials or
 * network are needed. Everything else (command invocation, before_agent_start,
 * prompt assembly, persistence) is production code.
 */

type FakeResponse = { text: string };

interface CapturedRequest {
  systemPrompt: string;
  messages: any[];
}

interface HarnessState {
  streamCalls: number;
  requests: CapturedRequest[];
}

const TEAM_NAME = "entry-request-team";

const MODEL_CONFIG = {
  id: "entry-request-model",
  name: "Entry request model",
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
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Minimal provider stream implementing the pi-ai AssistantMessageEventStream contract. */
function responseStream(response: FakeResponse): any {
  const pending = {
    role: "assistant",
    content: [{ type: "text", text: response.text }],
    api: "openai-completions",
    provider: "entry-request",
    model: MODEL_CONFIG.id,
    usage: usage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const final = { ...pending, stopReason: "stop" };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: pending };
      yield { type: "done", reason: "stop", message: final };
    },
    result: async () => final,
  };
}

interface Harness {
  session: any;
  sessionManager: SessionManager;
  state: HarnessState;
  runTeamCommand: (args: string) => Promise<void>;
  dispose: () => void;
}

async function createHarness(): Promise<Harness> {
  const state: HarnessState = { streamCalls: 0, requests: [] };
  const agentDir = mkdtempSync(join(tmpdir(), "pi-entry-request-"));
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const sessionManager = SessionManager.inMemory(process.cwd());
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();

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
        name: "entry-request-test",
        factory: async (pi: ExtensionAPI) => {
          // Capture command definitions, then register them for real. A Proxy is
          // required because the API instance's methods are not writable.
          const proxied = new Proxy(pi, {
            get(target, prop) {
              if (prop === "registerCommand") {
                return (name: string, def: any) => {
                  commands.set(name, def);
                  return target.registerCommand(name, def);
                };
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as ExtensionAPI;
          const mod = await import("../index");
          mod.default(proxied);
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
  modelRuntime.registerProvider("entry-request", {
    name: "Entry request provider",
    api: "openai-completions",
    baseUrl: "http://entry-request.invalid",
    apiKey: "in-process-test-key",
    models: [MODEL_CONFIG],
    streamSimple: (_model: any, context: any) => {
      state.streamCalls += 1;
      // Captured AFTER pi's convertToLlm: this is what the model would see.
      // The system prompt travels alongside (not inside) the message list.
      state.requests.push({
        systemPrompt: String(context.systemPrompt ?? ""),
        messages: context.messages ?? [],
      });
      return responseStream({ text: "ok" });
    },
  });
  const model = modelRuntime.getModel("entry-request", MODEL_CONFIG.id);
  if (!model) throw new Error("Failed to create fake test model");

  const session = (
    await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
    })
  ).session;
  await session.bindExtensions({ mode: "print" });

  return {
    session,
    sessionManager,
    state,
    runTeamCommand: async (args: string) => {
      const def = commands.get("team");
      if (!def) throw new Error("/team command was not registered");
      await def.handler(args, createMockContext({ cwd: process.cwd() }));
    },
    dispose: () => {
      session.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
      .join("");
  }
  return "";
}

describe("session entry notice — request-level (real AgentSession)", () => {
  let rootDir: string;
  let harness: Harness;
  let savedTeamRole: string | undefined;

  beforeEach(async () => {
    // This test suite must behave like a normal TL session. When the suite
    // itself runs inside a team member process, TEAM_ROLE makes index.ts exit
    // early (member mode) and nothing gets registered.
    savedTeamRole = process.env.TEAM_ROLE;
    delete process.env.TEAM_ROLE;
    rootDir = mkdtempSync(join(tmpdir(), "pi-entry-request-root-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    writeTeam(
      {
        name: TEAM_NAME,
        description: "Request-level test team",
        members: [{ name: "worker", systemPrompt: "do work" }],
      } as any,
      rootDir,
    );
    harness = await createHarness();
  });

  afterEach(() => {
    endSession();
    harness.dispose();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(rootDir, { recursive: true, force: true });
    if (savedTeamRole === undefined) delete process.env.TEAM_ROLE;
    else process.env.TEAM_ROLE = savedTeamRole;
  });

  it("puts the notice after the user message in the outbound request and persists it as a custom entry", async () => {
    // /team start itself must not call the model — it only flips state.
    await harness.runTeamCommand(`start ${TEAM_NAME}`);
    expect(harness.state.streamCalls).toBe(0);

    const userPrompt = "分析下 billing 模块有什么问题";
    await harness.session.prompt(userPrompt);

    expect(harness.state.requests).toHaveLength(1);
    const { messages, systemPrompt } = harness.state.requests[0];

    const userIndex = messages.findIndex(
      (m: any) => m?.role === "user" && messageText(m).includes(userPrompt),
    );
    const noticeIndex = messages.findIndex(
      (m: any) => m?.role === "user" && messageText(m).includes("系统通知｜团队会话状态"),
    );

    expect(userIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeGreaterThan(-1);
    // The notice rides AFTER the user's message: the last user-role content
    // before generation, without rewriting what the user typed.
    expect(noticeIndex).toBeGreaterThan(userIndex);
    expect(messageText(messages[userIndex])).toBe(userPrompt);
    expect(messageText(messages[noticeIndex])).toContain("不要回复本条");

    // The team prompt is still active in the same request.
    expect(systemPrompt).toContain("当前任务：Team Lead");
    expect(systemPrompt).toContain("状态：你正在团队会话中（Team Lead）");

    // Persisted as a custom message entry, so later turns can point at the switch.
    const entries = harness.sessionManager.getEntries();
    const noticeEntry = entries.find(
      (e: any) => e.type === "custom_message" && e.customType === "team-session-notice",
    ) as any;
    expect(noticeEntry).toBeDefined();
    expect(noticeEntry.display).toBe(true);
    expect(String(noticeEntry.content)).toContain("不要回复本条");
    expect(noticeEntry.details?.kind).toBe("session-entry");
    expect(noticeEntry.details?.teamName).toBe(TEAM_NAME);
  });
});
