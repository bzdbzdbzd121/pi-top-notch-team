import { describe, it, expect } from "vitest";
import { createTlReadGuard, createDesignReadGuard, MANAGEMENT_TOOLS } from "./tl-read-guard";

describe("createDesignReadGuard", () => {
  it("allows .md reads without counting them (docs are legitimate design work)", () => {
    const g = createDesignReadGuard();
    for (let i = 0; i < 10; i++) {
      expect(g.checkToolCall("read", "docs/guide.md").block).toBe(false);
    }
    expect(g.readCount).toBe(0);
  });

  it("allows reads with undefined path (cannot classify → fail-open)", () => {
    const g = createDesignReadGuard();
    for (let i = 0; i < 10; i++) {
      expect(g.checkToolCall("read", undefined).block).toBe(false);
    }
    expect(g.readCount).toBe(0);
  });

  it("never touches non-read tools (design-phase whitelist already blocks them)", () => {
    const g = createDesignReadGuard({ threshold: 1 });
    for (const tool of ["bash", "edit", "web_search", "fetch_content", "ctx_execute"]) {
      expect(g.checkToolCall(tool, undefined).block).toBe(false);
    }
    expect(g.readCount).toBe(0);
  });

  it("management tools are never in scope", () => {
    const g = createDesignReadGuard({ threshold: 1 });
    for (const tool of MANAGEMENT_TOOLS) {
      expect(g.checkToolCall(tool, undefined).block).toBe(false);
    }
    expect(g.readCount).toBe(0);
  });

  it("blocks every `threshold`-th code read ONCE, then lets the next read pass again (soft)", () => {
    const g = createDesignReadGuard({ threshold: 3 });
    // reads 1-2 pass
    expect(g.checkToolCall("read", "src/a.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(false);
    // 3rd read → blocked once with a reminder
    const blocked = g.checkToolCall("read", "src/c.ts");
    expect(blocked.block).toBe(true);
    expect(blocked.firstBlock).toBe(true);
    expect(blocked.reason).toContain("read");
    // next reads pass again — genuinely needed reads are retryable
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/e.ts").block).toBe(false);
    // 6th read → blocked again (periodic), but firstBlock only on the first block
    const blocked2 = g.checkToolCall("read", "src/f.ts");
    expect(blocked2.block).toBe(true);
    expect(blocked2.firstBlock).toBeUndefined();
    // and the next one passes again
    expect(g.checkToolCall("read", "src/g.ts").block).toBe(false);
  });

  it("threshold=1 blocks every other read (soft alternation)", () => {
    const g = createDesignReadGuard({ threshold: 1 });
    expect(g.checkToolCall("read", "src/a.ts").block).toBe(true);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(false);
  });

  it("resetTurn restores the budget and resets the firstBlock flag", () => {
    const g = createDesignReadGuard({ threshold: 3 });
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("read", "src/b.ts");
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true); // firstBlock

    g.resetTurn();
    expect(g.readCount).toBe(0);
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("read", "src/b.ts");
    const v = g.checkToolCall("read", "src/c.ts");
    expect(v.block).toBe(true);
    expect(v.firstBlock).toBe(true); // fresh turn → first block notifies again
  });

  it("defaults to threshold 4 (every 4th code read is blocked once, same rhythm as the execution-phase guard)", () => {
    const g = createDesignReadGuard();
    expect(g.checkToolCall("read", "src/a.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true);
    expect(g.checkToolCall("read", "src/e.ts").block).toBe(false);
  });
});

describe("createTlReadGuard", () => {
  it("allows .md reads without counting them", () => {
    const g = createTlReadGuard();
    for (let i = 0; i < 10; i++) {
      expect(g.checkToolCall("read", "docs/guide.md").block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(0);
  });

  it("allows reads with undefined path (cannot classify → fail-open)", () => {
    const g = createTlReadGuard({ threshold: 0 });
    expect(g.checkToolCall("read", undefined).block).toBe(false);
    expect(g.preDispatchCalls).toBe(0);
  });

  it("allows up to `threshold` non-management tool calls without blocking", () => {
    const g = createTlReadGuard({ threshold: 3 });
    expect(g.checkToolCall("read", "src/a.ts").block).toBe(false);
    expect(g.checkToolCall("bash", undefined).block).toBe(false);
    expect(g.checkToolCall("web_search", undefined).block).toBe(false);
    expect(g.preDispatchCalls).toBe(3);
  });

  it("blocks the threshold+1 call with firstBlock=true, then stays sticky until dispatch", () => {
    const g = createTlReadGuard({ threshold: 3 });
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("bash", undefined);
    g.checkToolCall("ctx_execute", undefined);

    const verdict = g.checkToolCall("read", "src/d.ts");
    expect(verdict.block).toBe(true);
    expect(verdict.firstBlock).toBe(true);
    expect(verdict.reason).toContain("team_send_and_wait");

    // sticky: subsequent calls are ALSO blocked (no escape hatch before dispatch)
    expect(g.checkToolCall("bash", undefined).block).toBe(true);
    expect(g.checkToolCall("bash", undefined).firstBlock).toBeUndefined(); // not the first block
    expect(g.checkToolCall("read", "src/f.ts").block).toBe(true);
    expect(g.checkToolCall("web_search", undefined).block).toBe(true);
  });

  it("unlocks after a dispatch: everything passes again", () => {
    const g = createTlReadGuard({ threshold: 1 });
    g.checkToolCall("bash", undefined);
    expect(g.checkToolCall("bash", undefined).block).toBe(true); // sticky
    g.recordDispatch();
    expect(g.checkToolCall("bash", undefined).block).toBe(false);
    expect(g.checkToolCall("read", "src/x.ts").block).toBe(false);
  });

  it("never blocks management tools", () => {
    const g = createTlReadGuard({ threshold: 0 }); // threshold 0 = sticky immediately for non-mgmt
    for (const tool of MANAGEMENT_TOOLS) {
      expect(g.checkToolCall(tool, undefined).block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(0);
  });

  it("management tools remain usable while sticky (dispatch path stays open)", () => {
    const g = createTlReadGuard({ threshold: 0 });
    expect(g.checkToolCall("bash", undefined).block).toBe(true); // sticky
    // The unlock tool itself must never be blocked
    expect(g.checkToolCall("team_send_and_wait", undefined).block).toBe(false);
  });

  it("never blocks after a dispatch happened this turn", () => {
    const g = createTlReadGuard({ threshold: 1 });
    g.checkToolCall("read", "src/a.ts");
    g.recordDispatch();
    expect(g.checkToolCall("bash", undefined).block).toBe(false);
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(false);
    expect(g.checkToolCall("web_search", undefined).block).toBe(false);
  });

  it("counts bash, ctx_execute, ctx_execute_file, web_search as non-management calls", () => {
    const g = createTlReadGuard({ threshold: 5 });
    g.checkToolCall("bash", undefined);
    g.checkToolCall("ctx_execute", undefined);
    g.checkToolCall("ctx_execute_file", undefined);
    g.checkToolCall("web_search", undefined);
    g.checkToolCall("fetch_content", undefined);
    expect(g.preDispatchCalls).toBe(5);
  });

  it("resetTurn restores the budget and lifts sticky mode", () => {
    const g = createTlReadGuard({ threshold: 1 });
    g.checkToolCall("bash", undefined);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(true); // sticky on
    expect(g.checkToolCall("bash", undefined).block).toBe(true);

    g.resetTurn();
    expect(g.preDispatchCalls).toBe(0);
    expect(g.checkToolCall("bash", undefined).block).toBe(false);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(true); // re-armed: firstBlock again
    expect(g.checkToolCall("bash", undefined).block).toBe(true); // sticky again
  });

  it("dispatch in a previous turn does not carry over after reset", () => {
    const g = createTlReadGuard({ threshold: 1 });
    g.recordDispatch();
    g.resetTurn();
    g.checkToolCall("bash", undefined);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(true);
  });

  it("defaults to threshold 3", () => {
    const g = createTlReadGuard();
    g.checkToolCall("bash", undefined);
    g.checkToolCall("read", "b.ts");
    g.checkToolCall("web_search", undefined);
    expect(g.checkToolCall("read", "d.ts").block).toBe(true);
  });

  it("write and edit are management tools and never count", () => {
    const g = createTlReadGuard({ threshold: 0 });
    expect(g.checkToolCall("write", "shared-context.md").block).toBe(false);
    expect(g.checkToolCall("edit", "some.md").block).toBe(false);
    expect(g.preDispatchCalls).toBe(0);
  });
});
