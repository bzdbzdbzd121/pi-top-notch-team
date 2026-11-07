import { describe, it, expect } from "vitest";
import {
  createTlReadGuard,
  createDesignReadGuard,
  MANAGEMENT_TOOLS,
  DESIGN_READ_GUARD_THRESHOLD,
  EXEMPT_ACTIONS_LINE,
} from "./tl-read-guard";
import { SESSION_TOOL_NAMES } from "./session-tool-visibility";
import { DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD } from "../settings/tl-self-work-guard-constants";

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

  it("ask_user_question / todo are exempt: never counted, never sticky-blocked", () => {
    const g = createTlReadGuard({ threshold: 0 }); // sticky immediately for non-mgmt
    expect(g.checkToolCall("bash", undefined).block).toBe(true); // sticky on
    // Planning/alignment tools remain usable and do not consume the budget.
    expect(g.checkToolCall("ask_user_question", undefined).block).toBe(false);
    expect(g.checkToolCall("todo", undefined).block).toBe(false);
    expect(g.preDispatchCalls).toBe(1); // only bash counted
  });

  it("write_shared_context is exempt: it is step 1 of the first-action protocol", () => {
    // Regression: the guard counted write_shared_context as a non-management
    // call, so a TL past the threshold could not write the shared context —
    // and start_member is refused until that flag is set. The protocol's first
    // step would be blocked by the guard enforcing the same protocol.
    const g = createTlReadGuard({ threshold: 0 }); // sticky immediately for non-mgmt
    expect(g.checkToolCall("bash", undefined).block).toBe(true); // sticky on
    expect(g.checkToolCall("write_shared_context", undefined).block).toBe(false);
    expect(g.preDispatchCalls).toBe(1); // only bash counted
  });

  it("write_shared_context does not consume the pre-dispatch budget", () => {
    const g = createTlReadGuard({ threshold: 2 });
    for (let i = 0; i < 10; i++) {
      expect(g.checkToolCall("write_shared_context", undefined).block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(0);
    // the budget is still intact afterwards: threshold calls pass, next blocks
    expect(g.checkToolCall("read", "src/a.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/b.ts").block).toBe(false);
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true);
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

// ── 阶段 2：可配置（开关 / 次数）+ 豁免不变式 ──────────────────────

describe("createTlReadGuard — 可配置（阶段 2）", () => {
  const EXEMPT_LIST_MARKER = "以下动作不受此限制";

  it("defaults to 3 and enabled (缺省即现状)", () => {
    const g = createTlReadGuard();
    expect(g.enabled).toBe(true);
    expect(g.threshold).toBe(3);
  });

  it("disabled: every code read passes and nothing is counted (preDispatchCalls stays 0)", () => {
    const g = createTlReadGuard({ enabled: false });
    for (let i = 0; i < 6; i++) {
      expect(g.checkToolCall("read", `src/f${i}.ts`).block).toBe(false);
    }
    // 关闭期间不计数：否则重新开启时会立刻粘滞（历史累计变成隐藏的惩罚）
    expect(g.preDispatchCalls).toBe(0);
  });

  it("disabled: non-read tools also pass and stay uncounted", () => {
    const g = createTlReadGuard({ enabled: false });
    for (const tool of ["bash", "web_search", "ctx_execute", "fetch_content"]) {
      expect(g.checkToolCall(tool, undefined).block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(0);
  });

  it("configure() applies a new threshold mid-turn WITHOUT resetting the turn counter", () => {
    const g = createTlReadGuard();
    g.checkToolCall("read", "src/a.ts"); // count = 1
    g.configure({ enabled: true, threshold: 5 });
    expect(g.threshold).toBe(5);
    expect(g.preDispatchCalls).toBe(1);
    // 剩余预算 = 5 - 1 = 4 次
    for (const p of ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]) {
      expect(g.checkToolCall("read", p).block).toBe(false);
    }
    expect(g.checkToolCall("read", "src/f.ts").block).toBe(true);
  });

  it("configure({enabled:false}) mid-turn stops blocking immediately but keeps the count", () => {
    const g = createTlReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true); // sticky
    g.configure({ enabled: false, threshold: 3 });
    expect(g.enabled).toBe(false);
    // 关闭后连读放行（粘滞态被绕过），计数冻结在 4（不重置、不增长）
    for (let i = 0; i < 6; i++) {
      expect(g.checkToolCall("read", `src/x${i}.ts`).block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(4);
  });

  it("blocking reasons carry the current threshold and the exempt-action list", () => {
    const g = createTlReadGuard({ threshold: 5 });
    for (let i = 0; i < 5; i++) expect(g.checkToolCall("read", `src/f${i}.ts`).block).toBe(false);

    const first = g.checkToolCall("read", "src/g.ts");
    expect(first.block).toBe(true);
    expect(first.reason).toContain("5 次/回合");
    expect(first.reason).toContain(EXEMPT_LIST_MARKER);
    expect(first.reason).toContain("write_shared_context");
    expect(first.reason).toContain("start_member");
    expect(first.reason).toContain("/team setting");

    const sticky = g.checkToolCall("read", "src/h.ts");
    expect(sticky.block).toBe(true);
    expect(sticky.reason).toContain("5 次/回合");
    expect(sticky.reason).toContain(EXEMPT_LIST_MARKER);
    expect(sticky.reason).toContain("write_shared_context");
    expect(sticky.reason).toContain("/team setting");
  });

  it(".md reads stay exempt while sticky and never increment the counter (safety valve before counting)", () => {
    const g = createTlReadGuard({ threshold: 2 });
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("read", "src/b.ts");
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true); // sticky
    const before = g.preDispatchCalls;
    for (let i = 0; i < 5; i++) {
      expect(g.checkToolCall("read", "DESIGN.md").block).toBe(false);
      expect(g.checkToolCall("read", undefined).block).toBe(false);
    }
    expect(g.preDispatchCalls).toBe(before);
  });

  it("management tools stay usable while disabled or sticky (dispatch path never closes)", () => {
    for (const enabled of [true, false]) {
      const g = createTlReadGuard({ enabled, threshold: 2 });
      g.checkToolCall("read", "src/a.ts");
      g.checkToolCall("read", "src/b.ts");
      g.checkToolCall("read", "src/c.ts");
      for (const tool of MANAGEMENT_TOOLS) {
        expect(g.checkToolCall(tool, undefined).block).toBe(false);
      }
    }
  });

  it("resetTurn keeps the configured threshold/enabled (配置按回合边界注入，不随重置丢失)", () => {
    const g = createTlReadGuard();
    g.configure({ enabled: false, threshold: 7 });
    g.resetTurn();
    expect(g.enabled).toBe(false);
    expect(g.threshold).toBe(7);
  });
});

describe("createDesignReadGuard — 可配置（阶段 2）", () => {
  it("keeps the fixed rhythm of 4 (named constant, independent of the execution-phase threshold)", () => {
    expect(DESIGN_READ_GUARD_THRESHOLD).toBe(4);
    const g = createDesignReadGuard();
    expect(g.enabled).toBe(true);
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      expect(g.checkToolCall("read", p).block).toBe(false);
    }
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true);
  });

  it("disabled: 8 code reads pass and readCount stays 0 (关闭时完全不计数)", () => {
    const g = createDesignReadGuard({ enabled: false });
    for (let i = 0; i < 8; i++) {
      expect(g.checkToolCall("read", `src/f${i}.ts`).block).toBe(false);
    }
    expect(g.readCount).toBe(0);
  });

  it("configure({enabled:false}) mid-turn stops the reminders immediately", () => {
    const g = createDesignReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true); // 4th
    g.configure({ enabled: false });
    for (let i = 0; i < 8; i++) {
      expect(g.checkToolCall("read", `src/x${i}.ts`).block).toBe(false);
    }
  });

  it("enabled again: the rhythm resumes (soft reminders, never sticky)", () => {
    const g = createDesignReadGuard({ enabled: false });
    for (let i = 0; i < 4; i++) g.checkToolCall("read", `src/f${i}.ts`);
    g.configure({ enabled: true });
    // readCount 未增长（关闭期间不计数）→ 重新开启后前 3 次仍放行
    for (const p of ["src/g.ts", "src/h.ts", "src/i.ts"]) {
      expect(g.checkToolCall("read", p).block).toBe(false);
    }
    expect(g.checkToolCall("read", "src/j.ts").block).toBe(true);
  });
});

describe("豁免名单不变式（协议依赖的工具永不计数）", () => {
  it("tools the start_member hard gate depends on are exempt (死锁类缺陷的直接护栏)", () => {
    // write_shared_context 未写入前 start_member 被硬门控拒绝；若前者被计数，
    // 粘滞态下二者互相锁死，TL 只能回头找用户（真实缺陷回归护栏）。
    for (const tool of ["write_shared_context", "start_member"]) {
      expect(MANAGEMENT_TOOLS.has(tool)).toBe(true);
    }
  });

  it("every session-scoped team tool is exempt (consistency snapshot — 变红 = 设计决策点，不是自动加白名单)", () => {
    for (const tool of SESSION_TOOL_NAMES) {
      expect(MANAGEMENT_TOOLS.has(tool)).toBe(true);
    }
  });

  it("exempt tools never unlock the guard (they do not reset the counter either)", () => {
    const g = createTlReadGuard({ threshold: 2 });
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("write_shared_context", undefined);
    g.checkToolCall("start_member", undefined);
    expect(g.preDispatchCalls).toBe(1);
    // 仍然只有派发能解锁：豁免调用不改变粘滞判定
    g.checkToolCall("read", "src/b.ts");
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true);
  });
});

// ── 阶段 2 审查：configure 与 sticky 的耦合 / 文案一致性 / 入参防御 ──

describe("configure 与 sticky 的耦合（由关变开必须清掉陈旧粘滞）", () => {
  it("disabled→enabled clears sticky AND the stale count (fresh budget, notification re-armed)", () => {
    const g = createTlReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true); // sticky, count = 4

    g.configure({ enabled: false, threshold: 3 });
    g.configure({ enabled: true, threshold: 3 });

    // 关闭期间的「不计数」语义延伸到重新开启：预算从零开始，不继承关闭前的债
    expect(g.preDispatchCalls).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(g.checkToolCall("read", `src/e${i}.ts`).block).toBe(false);
    }
    const first = g.checkToolCall("read", "src/f.ts");
    expect(first.block).toBe(true);
    // 重新武装后第一次拦截仍带通知标记（不是静默的陈旧粘滞）
    expect(first.firstBlock).toBe(true);
  });

  it("enabled→enabled configure keeps the turn's counters and sticky state (既有语义不变)", () => {
    const g = createTlReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true);
    g.configure({ enabled: true, threshold: 3 }); // 同一状态重复注入
    expect(g.preDispatchCalls).toBe(4);
    expect(g.checkToolCall("read", "src/e.ts").block).toBe(true); // 仍粘滞
  });

  it("production path (resetTurn → configure) is unchanged: a disabled turn leaves no residue", () => {
    const g = createTlReadGuard();
    // 第 1 回合：关闭
    g.resetTurn();
    g.configure({ enabled: false, threshold: 3 });
    for (let i = 0; i < 6; i++) g.checkToolCall("read", `src/a${i}.ts`);
    // 第 2 回合：开启
    g.resetTurn();
    g.configure({ enabled: true, threshold: 3 });
    expect(g.preDispatchCalls).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(g.checkToolCall("read", `src/b${i}.ts`).block).toBe(false);
    }
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true);
  });

  it("defensive: non-integer / NaN / out-of-range thresholds fall back to the default", () => {
    const g = createTlReadGuard();
    for (const bad of [Number.NaN, 2.5, 1, 0, -3, Number.POSITIVE_INFINITY]) {
      g.configure({ enabled: true, threshold: bad });
      expect(g.threshold).toBe(DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD);
    }
    g.configure({ enabled: true, threshold: 2 });
    expect(g.threshold).toBe(2); // 合法下界仍接受
  });
});

describe("拦截文案豁免清单与 MANAGEMENT_TOOLS 事实一致", () => {
  it("names every management tool (含 add_dynamic_member 与 agent 会话生命周期工具)", () => {
    for (const tool of MANAGEMENT_TOOLS) {
      expect(EXEMPT_ACTIONS_LINE).toContain(tool);
    }
  });

  it("never advertises a counting tool as exempt", () => {
    for (const tool of ["bash", "web_search", "fetch_content", "ctx_execute", "ctx_search"]) {
      expect(EXEMPT_ACTIONS_LINE).not.toContain(tool);
    }
  });

  it("points at the settings entry", () => {
    expect(EXEMPT_ACTIONS_LINE).toContain("/team setting");
  });
});

describe("设计阶段软提醒的对等入口", () => {
  it("mentions /team setting so the user can turn the reminder off", () => {
    const g = createDesignReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    const blocked = g.checkToolCall("read", "src/d.ts");
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("/team setting");
  });
});

// ── 阶段 2 审查末轮：enabled 入参 fail-safe / 设计限制器复位对称 / 文案双向 ──

describe("configure 的 enabled 入参 fail-safe（异常保持约束）", () => {
  it("只认字面 false：undefined / null / \"false\" / 0 一律保持开启", () => {
    const g = createTlReadGuard();
    for (const bad of [undefined, null, "false", 0]) {
      g.configure({ enabled: bad as unknown as boolean, threshold: 3 });
      expect(g.enabled).toBe(true);
    }
    g.configure({ enabled: false, threshold: 3 });
    expect(g.enabled).toBe(false);
  });

  it("fail-safe 后仍会拦截（不是静默关闭）", () => {
    const g = createTlReadGuard();
    g.configure({ enabled: undefined as unknown as boolean, threshold: 2 });
    for (const p of ["src/a.ts", "src/b.ts"]) expect(g.checkToolCall("read", p).block).toBe(false);
    expect(g.checkToolCall("read", "src/c.ts").block).toBe(true);
  });
});

describe("createDesignReadGuard — 关→开复位对称 + enabled fail-safe", () => {
  it("关→开复位 readCount / justBlocked / firstBlocked（与执行阶段限制器对称）", () => {
    const g = createDesignReadGuard();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) g.checkToolCall("read", p);
    expect(g.checkToolCall("read", "src/d.ts").block).toBe(true); // 4th, firstBlock
    expect(g.readCount).toBe(4);

    g.configure({ enabled: false });
    g.configure({ enabled: true });

    // 关闭期间不计数 → 重新开启从零预算开始（对称复位）
    expect(g.readCount).toBe(0);
    for (const p of ["src/e.ts", "src/f.ts", "src/g.ts"]) {
      expect(g.checkToolCall("read", p).block).toBe(false);
    }
    const again = g.checkToolCall("read", "src/h.ts");
    expect(again.block).toBe(true);
    // 重新武装后 firstBlock 重新为真（用户可见通知恢复，而不是沉默的第 N 次提醒）
    expect(again.firstBlock).toBe(true);
  });

  it("同状态 / 关→关的 configure 不清零（生产路径 resetTurn → configure 行为不变）", () => {
    const g = createDesignReadGuard();
    g.checkToolCall("read", "src/a.ts");
    g.checkToolCall("read", "src/b.ts");
    g.configure({ enabled: true }); // 已开启 → 不动
    expect(g.readCount).toBe(2);
    g.configure({ enabled: false }); // 开→关 → 不清（关闭期间本就不计数）
    expect(g.readCount).toBe(2);
  });

  it("fail-safe: enabled 非字面 false 一律保持开启", () => {
    const g = createDesignReadGuard();
    for (const bad of [undefined, null, "false", 0]) {
      g.configure({ enabled: bad as unknown as boolean });
      expect(g.enabled).toBe(true);
    }
    g.configure({ enabled: false });
    expect(g.enabled).toBe(false);
  });
});

describe("豁免文案双向断言（解析文案，而不是采样几个工具）", () => {
  /** 从 EXEMPT_ACTIONS_LINE 解析出被广告为「不受此限制」的工具名。 */
  function advertisedTools(): string[] {
    const bullet = EXEMPT_ACTIONS_LINE.split("\n").find((line) =>
      line.startsWith("• 以下动作不受此限制")
    );
    expect(bullet).toBeDefined();
    // 取冒号后的工具枚举；「，以及读取 .md 文档（…）」不是工具名，先切掉。
    const payload = bullet!.slice(bullet!.indexOf("：") + 1).split("，以及")[0];
    return payload
      .split("、")
      .flatMap((seg) => seg.replace(/（[^）]*）/g, "").trim().split("/"))
      .map((seg) => seg.replace(/。$/, "").trim())
      .filter((seg) => /^[a-z_][a-z0-9_]*$/.test(seg));
  }

  it("解析出的每一项都 ∈ MANAGEMENT_TOOLS（文案不得广告会计数的工具）", () => {
    const advertised = advertisedTools();
    expect(advertised.length).toBeGreaterThan(10);
    for (const tool of advertised) {
      expect(MANAGEMENT_TOOLS.has(tool)).toBe(true);
    }
  });

  it("解析结果与 MANAGEMENT_TOOLS 完全一致（无遗漏、无多余）", () => {
    expect(advertisedTools().sort()).toEqual([...MANAGEMENT_TOOLS].sort());
  });
});
