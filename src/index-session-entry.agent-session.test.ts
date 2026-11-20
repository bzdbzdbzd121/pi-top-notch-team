import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { endSession, getSessionState } from "./session/state";
import { writeTeam } from "./team/store";
import {
  SESSION_ENTRY_NOTICE_ANCHOR,
  SESSION_ENTRY_NOTICE_MAX_TURNS,
} from "./prompts/session-transition-notice";

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

type FakeCall = { name: string; arguments: Record<string, unknown> };
type FakeResponse = { text: string; tool?: FakeCall; inputTokens?: number };

interface CapturedRequest {
  systemPrompt: string;
  messages: any[];
  tools: Array<{ name: string }>;
}

interface HarnessState {
  streamCalls: number;
  requests: CapturedRequest[];
  nextTool?: FakeCall;
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
    usage: { ...usage(), ...(response.inputTokens ? { input: response.inputTokens, totalTokens: response.inputTokens + 1 } : {}) },
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const stopReason = response.tool ? "toolUse" : "stop";
  const final = {
    ...pending,
    stopReason,
    content: response.tool ? [{ type: "toolCall", id: "call_test", ...response.tool }] : pending.content,
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: pending };
      yield { type: "done", reason: stopReason, message: final };
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

async function createHarness(options: { keepPrompt?: string; autoCompact?: boolean } = {}): Promise<Harness> {
  const state: HarnessState = { streamCalls: 0, requests: [] };
  const agentDir = mkdtempSync(join(tmpdir(), "pi-entry-request-"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: options.autoCompact ?? false, keepRecentTokens: 1, reserveTokens: 0 },
  }, { projectTrusted: true });
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
          if (options.keepPrompt) {
            pi.on("session_before_compact", (event) => {
              const keep = event.branchEntries.find((entry) => entry.type === "message" &&
                entry.message.role === "user" && messageText(entry.message) === options.keepPrompt);
              if (!keep) throw new Error("Missing compaction fixture keep point");
              return { compaction: { ...event.preparation, summary: "fixture summary", firstKeptEntryId: keep.id } };
            });
            if (options.autoCompact) pi.on("session_compact", () => settingsManager.setCompactionEnabled(false));
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
        tools: (context.tools ?? []).map(({ name, description, parameters }: any) => ({
          name, description, parameters,
        })),
      });
      const tool = state.nextTool;
      state.nextTool = undefined;
      return responseStream({ text: "ok", tool, inputTokens: options.autoCompact && state.streamCalls === 2 ? 1_000_000 : undefined });
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
      await def.handler(args, { ...createMockContext({ cwd: process.cwd() }), sessionManager });
    },
    dispose: () => {
      session.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

/** How many notice messages a request carries (each one is a separate user-role part). */
function countNotices(messages: any[]): number {
  return messages.filter(
    (m: any) => m?.role === "user" && messageText(m).startsWith(SESSION_ENTRY_NOTICE_ANCHOR),
  ).length;
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

  it.each([`start ${TEAM_NAME}`, "dynamic"])("keeps the prompt and tool definitions stable after opening via /team %s", { timeout: 20_000 }, async (command) => {
    await harness.runTeamCommand(command);
    await harness.session.prompt("团队首轮");
    await harness.session.prompt("团队第二轮");

    const [first, second] = harness.state.requests;
    expect(first.systemPrompt).toContain("当前任务：Team Lead");
    expect(first.systemPrompt).not.toContain("- stop_team_session:");
    expect(first.tools.map((tool) => tool.name)).toContain("write_shared_context");
    expect(first.tools.map((tool) => tool.name)).not.toContain("stop_team_session");
    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.tools).toEqual(second.tools);
  });

  it("appends the exit and resume notices once without changing the system prompt in either mode", { timeout: 20_000 }, async () => {
    const exitText = "团队会话已结束";
    const resumeText = "团队会话已从中断中恢复";
    const exitUser = "我还在团队会话吗？";
    const resumeUser = "恢复后要先做什么？";
    await harness.session.prompt("普通模式");
    await harness.runTeamCommand(`start ${TEAM_NAME}`);
    await harness.session.prompt("进入团队");
    await harness.runTeamCommand("stop");
    expect(harness.state.streamCalls).toBe(2);
    await harness.session.prompt(exitUser);
    await harness.session.prompt("退出后的第二轮");
    await harness.runTeamCommand(`resume ${TEAM_NAME}`);
    expect(harness.state.streamCalls).toBe(4);
    await harness.session.prompt(resumeUser);
    await harness.session.prompt("恢复后的第二轮");

    expect(harness.state.requests).toHaveLength(6);
    const [ordinary, team, exited, afterExit, resumed, afterResume] = harness.state.requests;
    expect(exited.systemPrompt).toBe(ordinary.systemPrompt);
    expect(exited.systemPrompt).toBe(afterExit.systemPrompt);
    expect(exited.tools).toEqual(ordinary.tools);
    expect(exited.tools).toEqual(afterExit.tools);
    expect(resumed.systemPrompt).toBe(team.systemPrompt);
    expect(resumed.systemPrompt).toBe(afterResume.systemPrompt);
    expect(resumed.tools).toEqual(team.tools);
    expect(resumed.tools).toEqual(afterResume.tools);

    for (const [first, next, user, notice] of [
      [exited, afterExit, exitUser, exitText],
      [resumed, afterResume, resumeUser, resumeText],
    ] as const) {
      expect(messageText(first.messages.at(-2))).toBe(user);
      expect(first.messages.at(-1)?.role).toBe("user");
      expect(messageText(first.messages.at(-1))).toContain(notice);
      // Later requests replay the original notice without editing the cached history or adding another copy.
      expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
      expect(next.messages.filter((m) => m.role === "user" && messageText(m).includes(notice))).toHaveLength(1);
      expect(harness.sessionManager.getEntries().filter((entry) =>
        entry.type === "custom_message" && !entry.display && String(entry.content).includes(notice),
      )).toHaveLength(1);
    }
    // The resume notice replaces (rather than duplicates) a new entry notice.
    expect(countNotices(resumed.messages)).toBe(countNotices(team.messages));
  });

  it("keeps an identical system prompt and tool schema across modes with the experimental gateway", { timeout: 20_000 }, async () => {
    const previous = process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
    process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = "1";
    try {
      harness.dispose();
      harness = await createHarness();
      await harness.session.prompt("普通模式");
      await harness.runTeamCommand(`start ${TEAM_NAME}`);
      await harness.session.prompt("团队模式");
      await harness.session.prompt("继续团队模式");
      await harness.runTeamCommand("stop");
      await harness.session.prompt("回到普通模式");
      await harness.runTeamCommand(`resume ${TEAM_NAME}`);
      await harness.session.prompt("恢复团队模式");
      const requests = harness.state.requests;
      expect(requests).toHaveLength(5);
      const [ordinary, entered, continued, exited, resumed] = requests;
      expect(ordinary.tools.map((t) => t.name)).toContain("team");
      expect(ordinary.tools.map((t) => t.name)).not.toContain("start_team_session");
      expect(ordinary.tools.map((t) => t.name)).not.toContain("start_member");
      for (const [i, request] of requests.entries()) {
        expect(request.tools).toEqual(ordinary.tools);
        expect(request.systemPrompt).toBe(ordinary.systemPrompt);
        if (i) {
          const older = requests[i - 1].messages;
          expect(request.messages.slice(0, older.length)).toEqual(older);
        }
      }
      expect(entered.messages.at(-1)).toMatchObject({ role: "user" });
      expect(messageText(entered.messages.at(-1))).toContain("当前任务：Team Lead");
      expect(messageText(entered.messages.at(-1))).toContain('team({"action":"list_members","args":{}})');
      expect(messageText(continued.messages.at(-1))).not.toContain("当前任务：Team Lead");
      expect(messageText(exited.messages.at(-1))).toContain("回到**普通模式**");
      expect(messageText(resumed.messages.at(-1))).toContain("团队会话已从中断中恢复");
      expect(messageText(resumed.messages.at(-1))).toContain("当前任务：Team Lead");
    } finally {
      if (previous === undefined) delete process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
      else process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = previous;
    }
  });

  it.each(["manual", "threshold", "retained", "restored"] as const)("keeps one visible persisted gateway snapshot after %s compaction", { timeout: 20_000 }, async (reason) => {
    const previous = process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
    process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = "1";
    const initial = "first team turn";
    const keep = "retained user turn";
    const keepPrompt = reason === "retained" ? initial : keep;
    try {
      harness.dispose();
      harness = await createHarness({ keepPrompt, autoCompact: reason === "threshold" });
      await harness.runTeamCommand(`start ${TEAM_NAME}`);
      await harness.session.prompt(initial);
      await harness.session.prompt(keep);
      const countSnapshots = (entries: ReturnType<SessionManager["getEntries"]>) => entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "team-mode-snapshot",
      ).length;
      if (reason === "manual" || reason === "retained") await harness.session.compact();
      if (reason === "restored") {
        // A session with a compaction entry saved before this hook was installed.
        const keepEntry = harness.sessionManager.getEntries().find((entry) =>
          entry.type === "message" && messageText(entry.message) === keep);
        expect(keepEntry).toBeDefined();
        harness.sessionManager.appendCompaction("fixture summary", keepEntry!.id, 1000);
        harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
        expect(countSnapshots(harness.sessionManager.buildContextEntries())).toBe(0);
      }
      expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(harness.state.streamCalls).toBe(2); // Neither compaction bookkeeping nor snapshot delivery starts a model turn.
      if (reason !== "restored") expect(countSnapshots(harness.sessionManager.buildContextEntries())).toBe(1);
      await harness.session.prompt("first after compaction");
      await harness.session.prompt("second after compaction");
      expect(countSnapshots(harness.sessionManager.getEntries())).toBe(reason === "retained" ? 1 : 2);
      expect(countSnapshots(harness.sessionManager.buildContextEntries())).toBe(1);
      const first = harness.state.requests[2];
      const second = harness.state.requests[3];
      const isSnapshot = (message: any) => messageText(message).includes("【团队状态｜以最新通知为准】");
      expect(first.messages.filter(isSnapshot)).toHaveLength(1);
      expect(second.messages.filter(isSnapshot)).toHaveLength(1);
      expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
      expect(first.systemPrompt).toBe(second.systemPrompt);
      expect(first.tools).toEqual(second.tools);
    } finally {
      if (previous === undefined) delete process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
      else process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = previous;
    }
  });

  it("checks gateway permissions and argument schemas before delegating to the original tools", { timeout: 20_000 }, async () => {
    const previous = process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
    process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = "1";
    try {
      harness.dispose();
      harness = await createHarness();
      const call = async (action: string, args: Record<string, unknown> = {}) => {
        harness.state.nextTool = { name: "team", arguments: { action, args } };
        await harness.session.prompt(`运行测试操作 ${action}`);
        const result = harness.state.requests.at(-1)?.messages.filter((m) => m.role === "toolResult").at(-1);
        expect(result?.toolName).toBe("team");
        return result;
      };
      const unavailable = async (action: string, args?: Record<string, unknown>) => {
        const result = await call(action, args);
        expect(result.isError).toBe(true);
        expect(messageText(result)).toContain("在当前状态不可用");
      };
      await unavailable("list_members");
      await unavailable("__proto__");
      writeFileSync(join(rootDir, "settings.yaml"), "allowAgentInitiatedSessions: false\n");
      await unavailable("start_team_session", { task: "Should never start" });
      expect(getSessionState().active).toBe(false);

      await harness.runTeamCommand(`start ${TEAM_NAME}`);
      await unavailable("stop_team_session");
      await unavailable("add_dynamic_member");
      expect(getSessionState().active).toBe(true);
      const invalid = await call("start_member", { name: 42 });
      expect(invalid.isError).toBe(true);
      expect(messageText(invalid)).toContain("参数不符合");
      const blockedByOriginalTool = await call("start_member", { name: "worker" });
      expect(messageText(blockedByOriginalTool)).toContain("write_shared_context");
      expect(getSessionState().sharedContextWritten).toBe(false);
      const allowed = await call("write_shared_context", { content: "synthetic fixture" });
      expect(allowed.isError).toBe(false);
      expect(getSessionState().sharedContextWritten).toBe(true);
      await harness.runTeamCommand("stop");
      await unavailable("write_shared_context", { content: "stale operation" });
      expect(getSessionState().active).toBe(false);

      writeFileSync(join(rootDir, "settings.yaml"), "allowAgentInitiatedSessions: true\n");
      const started = await call("start_team_session", { task: "Synthetic autonomous fixture" });
      expect(started.isError).toBe(false);
      expect(getSessionState().origin).toBe("agent");
      expect(messageText(started)).toContain("【团队状态｜以最新通知为准】");
      expect(messageText(started)).toContain('"action":"stop_team_session"');
      await unavailable("start_team_session", { task: "Must not create a nested session" });
      const stopped = await call("stop_team_session");
      expect(stopped.isError).toBe(false);
      expect(messageText(stopped)).toContain("当前是普通模式");
      expect(getSessionState().active).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE;
      else process.env.TOP_NOTCH_TEAM_EXPERIMENTAL_PREFIX_CACHE = previous;
    }
  });

  // Explicit timeout: this case drives THREE real prompts through the installed
  // AgentSession; the 5s default is fine on an idle machine and flaky on a loaded
  // CI box.
  it("puts the notice after the user message in the outbound request and persists it as a custom entry", { timeout: 20_000 }, async () => {
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
    expect(SESSION_ENTRY_NOTICE_MAX_TURNS).toBe(2);

    // The team prompt is still active in the same request.
    expect(systemPrompt).toContain("当前任务：Team Lead");
    expect(systemPrompt).toContain("状态：你正在团队会话中（Team Lead）");

    // Persisted as a custom message entry, so later turns can point at the switch.
    const entries = harness.sessionManager.getEntries();
    const noticeEntry = entries.find(
      (e: any) => e.type === "custom_message" && e.customType === "team-session-notice",
    ) as any;
    expect(noticeEntry).toBeDefined();
    // display:false keeps it out of the TUI, but persistence is unconditional —
    // this entry is exactly what historyHasTeamTraces reads for the exit banner.
    expect(noticeEntry.display).toBe(false);
    expect(String(noticeEntry.content)).toContain("不要回复本条");
    expect(noticeEntry.details?.kind).toBe("session-entry");
    expect(noticeEntry.details?.teamName).toBe(TEAM_NAME);

    // ── Replay path ──
    // Turn 2: the persisted entry is re-read through
    // sessionEntryToContextMessages → convertToLlm and sent again. display:false
    // is not a filter on that path either.
    // Turn 1 carried exactly one notice (the fresh injection).
    expect(countNotices(harness.state.requests[0].messages)).toBe(1);

    // Turn 2 injects once more and replays the first one → two.
    await harness.session.prompt("第二轮用户消息");
    expect(harness.state.requests).toHaveLength(2);
    expect(countNotices(harness.state.requests[1].messages)).toBe(2);

    // Turn 3 closes the window (SESSION_ENTRY_NOTICE_MAX_TURNS = 2 injections),
    // so the count must stay at two: both occurrences can ONLY come from replay
    // (a third injection would make it three). This is the assertion that fails
    // if display:false ever suppresses the replay path.
    await harness.session.prompt("第三轮用户消息");
    expect(harness.state.requests).toHaveLength(3);
    expect(countNotices(harness.state.requests[2].messages)).toBe(2);
  });
});
