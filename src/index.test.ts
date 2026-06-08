import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberOperationalState } from "./session/context";

// ── Helpers ────────────────────────────────────────────────

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
  } as any;
}

/**
 * Simulate the state transition logic that lives in index.ts's
 * createAndRegisterMember onEvent handler and sendToMember callback.
 */
function simulateStateTransitions() {
  const states = new Map<string, MemberOperationalState>();

  function handleEvent(memberName: string, event: any) {
    if (event.type === "agent_start") {
      states.set(memberName, "working");
    } else if (event.type === "agent_end") {
      states.set(memberName, "idle");
    } else if (event.type === "process_exit") {
      const exitCode = event.exitCode;
      const isNormalExit = exitCode === null || exitCode === 0 || exitCode === 143;
      states.set(memberName, isNormalExit ? "stopped" : "crashed");
    } else if (event.type === "process_error") {
      states.set(memberName, "crashed");
    }
  }

  function onSendPrompt(memberName: string) {
    states.set(memberName, "working");
  }

  function initState(memberName: string) {
    states.set(memberName, "idle");
  }

  /** Simulate the get_member_status tool's execute logic. */
  function getMemberStatusTool(): string {
    const entries = Array.from(states.entries());
    if (entries.length === 0) {
      return "还没有启动任何团队成员。请先使用 start_member 启动成员。";
    }
    const lines = entries.map(([name, state]) => {
      const icon = state === "working" ? "🔧"
        : state === "idle" ? "✅"
        : state === "crashed" ? "💥"
        : "⏹️";
      return `  ${icon} ${name}: ${state}`;
    });
    return `团队成员操作状态：\n${lines.join("\n")}`;
  }

  return { states, handleEvent, onSendPrompt, initState, getMemberStatusTool };
}

/**
 * Simulate the get_member_log content truncation logic.
 */
function simulateGetMemberLog(
  messages: { role: string; content: string }[],
  maxLines: number,
  maxContentLength?: number
): string {
  const effectiveMaxLen = maxContentLength ?? 50;

  const recent = messages.slice(-maxLines);
  return recent
    .map((m: any) => {
      let content = typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content);

      if (content.length > effectiveMaxLen) {
        content = content.slice(0, effectiveMaxLen) + "...";
      }

      return `[${m.role}] ${content}`;
    })
    .join("\n");
}

// ── Tests ──────────────────────────────────────────────────

describe("MemberOperationalState type", () => {
  it("should accept valid state values", () => {
    const idle: MemberOperationalState = "idle";
    const working: MemberOperationalState = "working";
    const crashed: MemberOperationalState = "crashed";
    const stopped: MemberOperationalState = "stopped";
    expect(idle).toBe("idle");
    expect(working).toBe("working");
    expect(crashed).toBe("crashed");
    expect(stopped).toBe("stopped");
  });

  it("should reject invalid state values at compile time", () => {
    // @ts-expect-error - "unknown" is not a valid MemberOperationalState
    const invalid: MemberOperationalState = "unknown";
    expect(invalid).toBeDefined(); // shouldn't actually compile
  });
});

describe("MemberOperationalState transitions", () => {
  let tracker: ReturnType<typeof simulateStateTransitions>;

  beforeEach(() => {
    tracker = simulateStateTransitions();
  });

  it("should initialize member state to idle", () => {
    tracker.initState("coder");
    expect(tracker.states.get("coder")).toBe("idle");
  });

  it("should transition from idle to working on agent_start", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "agent_start" });
    expect(tracker.states.get("coder")).toBe("working");
  });

  it("should transition from working to idle on agent_end", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "agent_start" });
    tracker.handleEvent("coder", { type: "agent_end" });
    expect(tracker.states.get("coder")).toBe("idle");
  });

  it("should transition to stopped on normal process_exit (code=0)", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 0 });
    expect(tracker.states.get("coder")).toBe("stopped");
  });

  it("should transition to stopped on process_exit code=143 (SIGTERM)", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 143 });
    expect(tracker.states.get("coder")).toBe("stopped");
  });

  it("should transition to stopped on process_exit with null code", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: null });
    expect(tracker.states.get("coder")).toBe("stopped");
  });

  it("should transition to crashed on abnormal process_exit (code=1)", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 1 });
    expect(tracker.states.get("coder")).toBe("crashed");
  });

  it("should transition to crashed on abnormal process_exit (code=137 SIGKILL)", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 137 });
    expect(tracker.states.get("coder")).toBe("crashed");
  });

  it("should transition to crashed on process_error", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_error", memberName: "coder" });
    expect(tracker.states.get("coder")).toBe("crashed");
  });

  it("should set working when sendToMember sends prompt", () => {
    tracker.initState("coder");
    tracker.onSendPrompt("coder");
    expect(tracker.states.get("coder")).toBe("working");
  });

  it("should track multiple members independently", () => {
    tracker.initState("analyzer");
    tracker.initState("coder");
    tracker.initState("reviewer");

    tracker.handleEvent("coder", { type: "agent_start" });
    expect(tracker.states.get("analyzer")).toBe("idle");
    expect(tracker.states.get("coder")).toBe("working");
    expect(tracker.states.get("reviewer")).toBe("idle");

    tracker.handleEvent("analyzer", { type: "process_exit", exitCode: 1 });
    expect(tracker.states.get("analyzer")).toBe("crashed");
    expect(tracker.states.get("coder")).toBe("working");

    tracker.handleEvent("coder", { type: "agent_end" });
    expect(tracker.states.get("coder")).toBe("idle");
  });

  it("should transition agent_start → working even if currently idle", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "agent_start" });
    expect(tracker.states.get("coder")).toBe("working");
    tracker.handleEvent("coder", { type: "agent_start" });
    expect(tracker.states.get("coder")).toBe("working");
  });

  it("should handle process_exit with wasRunning flag set to true", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 1, wasRunning: true });
    expect(tracker.states.get("coder")).toBe("crashed");
  });

  it("should handle process_exit with wasRunning flag false (already stopped)", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "process_exit", memberName: "coder", exitCode: 0, wasRunning: false });
    expect(tracker.states.get("coder")).toBe("stopped");
  });
});

describe("get_member_status tool", () => {
  let tracker: ReturnType<typeof simulateStateTransitions>;

  beforeEach(() => {
    tracker = simulateStateTransitions();
  });

  it("should return empty message when no members started", () => {
    const output = tracker.getMemberStatusTool();
    expect(output).toContain("还没有启动任何团队成员");
  });

  it("should return idle state for initialized members", () => {
    tracker.initState("coder");
    tracker.initState("analyzer");
    const output = tracker.getMemberStatusTool();
    expect(output).toContain("coder");
    expect(output).toContain("analyzer");
    expect(output).toContain("idle");
  });

  it("should report working state for members processing tasks", () => {
    tracker.initState("coder");
    tracker.handleEvent("coder", { type: "agent_start" });
    const output = tracker.getMemberStatusTool();
    expect(output).toContain("coder");
    expect(output).toContain("working");
  });

  it("should report crashed state for members with abnormal exit", () => {
    tracker.initState("analyzer");
    tracker.handleEvent("analyzer", { type: "process_exit", memberName: "analyzer", exitCode: 1 });
    const output = tracker.getMemberStatusTool();
    expect(output).toContain("analyzer");
    expect(output).toContain("crashed");
  });

  it("should report stopped state for members that exited normally", () => {
    tracker.initState("analyzer");
    tracker.handleEvent("analyzer", { type: "process_exit", memberName: "analyzer", exitCode: 0 });
    const output = tracker.getMemberStatusTool();
    expect(output).toContain("analyzer");
    expect(output).toContain("stopped");
  });

  it("should report mixed states for different members", () => {
    tracker.initState("analyzer"); // idle → stopped
    tracker.initState("coder");
    tracker.initState("reviewer");

    tracker.handleEvent("analyzer", { type: "process_exit", memberName: "analyzer", exitCode: 0 });
    tracker.handleEvent("coder", { type: "agent_start" });
    // reviewer stays idle

    const output = tracker.getMemberStatusTool();
    expect(output).toContain("analyzer: stopped");
    expect(output).toContain("coder: working");
    expect(output).toContain("reviewer: idle");
  });

  it("should display correct emoji icons per state", () => {
    tracker.initState("planner");
    tracker.initState("builder");
    tracker.initState("tester");
    tracker.initState("stopped_member");

    tracker.handleEvent("builder", { type: "agent_start" }); // working
    tracker.handleEvent("tester", { type: "process_exit", exitCode: 1 }); // crashed
    tracker.handleEvent("stopped_member", { type: "process_exit", exitCode: 0 }); // stopped

    const output = tracker.getMemberStatusTool();
    expect(output).toContain("✅ planner: idle");
    expect(output).toContain("🔧 builder: working");
    expect(output).toContain("💥 tester: crashed");
    expect(output).toContain("⏹️ stopped_member: stopped");
  });
});

describe("get_member_log content truncation", () => {
  const longContent = "A".repeat(100);

  it("should truncate long content to default 50 characters", () => {
    const result = simulateGetMemberLog(
      [{ role: "user", content: longContent }],
      10
    );
    expect(result).toBe("[user] " + "A".repeat(50) + "...");
    expect(result.length).toBeLessThan(longContent.length);
  });

  it("should respect custom maxContentLength", () => {
    const result = simulateGetMemberLog(
      [{ role: "user", content: longContent }],
      10,
      10
    );
    expect(result).toBe("[user] " + "A".repeat(10) + "...");
  });

  it("should not truncate content shorter than maxContentLength", () => {
    const shortContent = "Short message";
    const result = simulateGetMemberLog(
      [{ role: "assistant", content: shortContent }],
      10,
      50
    );
    expect(result).toBe("[assistant] " + shortContent);
    expect(result).not.toContain("...");
  });

  it("should handle empty content", () => {
    const result = simulateGetMemberLog(
      [{ role: "user", content: "" }],
      10,
      50
    );
    expect(result).toBe("[user] ");
  });

  it("should truncate at exact boundary", () => {
    // content length exactly equals maxContentLength → no truncation
    const exactContent = "A".repeat(50);
    const result = simulateGetMemberLog(
      [{ role: "user", content: exactContent }],
      10,
      50
    );
    expect(result).toBe("[user] " + "A".repeat(50));
    expect(result).not.toContain("...");

    // one byte over → truncate
    const overContent = "A".repeat(51);
    const result2 = simulateGetMemberLog(
      [{ role: "user", content: overContent }],
      10,
      50
    );
    expect(result2).toBe("[user] " + "A".repeat(50) + "...");
  });

  it("should handle maxContentLength of 0", () => {
    const result = simulateGetMemberLog(
      [{ role: "user", content: "anything" }],
      10,
      0
    );
    expect(result).toBe("[user] ...");
  });

  it("should truncate multiple messages independently", () => {
    const messages = [
      { role: "user", content: "Short" },
      { role: "assistant", content: "A" + "B".repeat(60) + "C" },
    ];
    const result = simulateGetMemberLog(messages, 10, 20);
    expect(result).toContain("[user] Short");
    expect(result).toContain("[assistant] " + "A" + "B".repeat(19) + "...");
    expect(result).not.toContain("C");
  });

  it("should respect maxLines as well as maxContentLength", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: longContent },
      { role: "user", content: "third" },
    ];
    // maxLines=2, so first message is excluded
    const result = simulateGetMemberLog(messages, 2, 10);
    expect(result).not.toContain("first");
    expect(result).toContain("[assistant] " + "A".repeat(10) + "...");
    expect(result).toContain("[user] third");
  });
});
