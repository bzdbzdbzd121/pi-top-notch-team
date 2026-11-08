import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildTeamStateDeclaration,
  buildSessionEntryNotice,
  decideEntryNotice,
  SESSION_ENTRY_NOTICE_ANCHOR,
  SESSION_ENTRY_NOTICE_CUSTOM_TYPE,
  SESSION_ENTRY_NOTICE_MAX_TURNS,
} from "./session-transition-notice";

/**
 * Stage 0 of the session-transition work: the persistent state declaration.
 *
 * Assertions lock the three speech acts the declaration must perform:
 *   1. name the current state (you ARE in a team session, with the team name);
 *   2. claim authority over the conversation history;
 *   3. give the phase-correct next step (dispatch chain vs confirmation gate).
 * Plus the anti-drift rule: `predefined` and `execution` are byte-identical.
 */
describe("buildTeamStateDeclaration — 执行态（预定义团队 / 动态执行阶段）", () => {
  const text = buildTeamStateDeclaration("predefined", "研发队");

  it("点明当前处于团队会话，并带上传入的团队名", () => {
    expect(text).toContain("状态：你正在团队会话中");
    expect(text).toContain("研发队");
  });

  it("声明权威：当前唯一有效的状态 + 冲突时以本提示为准", () => {
    expect(text).toContain("当前唯一有效的状态");
    expect(text).toContain("以本提示为准");
    // 权威声明限定于「冲突」情形，不是「所有历史一律无效」
    expect(text).toContain("与本提示冲突");
  });

  it("历史断言限定于「进入本会话之前」，不否定会话内的合法记录", () => {
    // 同一团队会话内有合法 read（设计阶段）、.md 写入、resume 历史——
    // 断言「所有自分析记录都发生在进入之前」是假的，会让模型整段折扣提示。
    expect(text).toContain("进入本会话之前");
    expect(text).toContain("属于普通模式");
    expect(text).toContain("不构成本回合的授权");
    expect(text).not.toContain("都发生在进入团队会话**之前**");
  });

  it("给出纠正动作：发现自己又亲自分析时立即改为派发", () => {
    expect(text).toContain("立即停下并改为派发");
  });

  it("不串味：不含设计阶段/确认门内容", () => {
    expect(text).not.toContain("设计阶段");
    expect(text).not.toContain("明确确认");
  });

  it("不复述动作链（动作链归第一动作协议单一来源）", () => {
    expect(text).not.toContain("write_shared_context");
    expect(text).not.toContain("start_member");
    expect(text).not.toContain("team_send_and_wait");
  });
});

describe("buildTeamStateDeclaration — 设计态", () => {
  const text = buildTeamStateDeclaration("design", "_dynamic_1750000000000");

  it("标注动态团队的设计阶段", () => {
    expect(text).toContain("状态：你正在团队会话中");
    expect(text).toContain("设计阶段");
  });

  it("声明权威：当前唯一有效的状态 + 冲突以本提示为准", () => {
    expect(text).toContain("当前唯一有效的状态");
    expect(text).toContain("以本提示为准");
  });

  it("含确认门：用户明确确认前不注册成员、不启动成员、不派发任务", () => {
    expect(text).toContain("明确确认");
    expect(text).toContain("不要注册成员");
    expect(text).toContain("不要启动成员");
    expect(text).toContain("不要派发任务");
  });

  it("不渲染合成团队名（_dynamic_<ts> 对模型无意义）", () => {
    expect(text).not.toContain("_dynamic_");
  });

  it("不串味：不含执行态的纠正/授权措辞", () => {
    expect(text).not.toContain("立即停下并改为派发");
    expect(text).not.toContain("不构成本回合的授权");
  });

  it("不复述工具名（设计阶段根本没有可派发的成员）", () => {
    expect(text).not.toContain("start_member");
    expect(text).not.toContain("team_send_and_wait");
  });
});

describe("buildTeamStateDeclaration — 变体关系", () => {
  it("predefined 与 execution 逐字节一致（同一执行态，防漂移）", () => {
    expect(buildTeamStateDeclaration("predefined", "研发队")).toBe(
      buildTeamStateDeclaration("execution", "研发队"),
    );
  });

  it("设计态与执行态是两份不同文案", () => {
    expect(buildTeamStateDeclaration("design", "研发队")).not.toBe(
      buildTeamStateDeclaration("execution", "研发队"),
    );
  });

  it("团队名按传入值渲染，不硬编码", () => {
    expect(buildTeamStateDeclaration("predefined", "alpha")).toContain("alpha");
    expect(buildTeamStateDeclaration("predefined", "alpha")).not.toContain("beta");
  });
});

// ────────────────────────────────────────────────────────────────
// Stage 1 — the bounded session entry notice
//
// Layer 2 answers "the switch just happened", which the persistent
// declaration cannot: the declaration is true every turn, the notice is true
// only for a bounded window. It is returned as a `message` from
// before_agent_start, so pi maps it to the user role right after the user's
// message (closest position to generation) and persists it as a custom
// session entry the later turns can point at. It never starts a turn itself.
// ────────────────────────────────────────────────────────────────

describe("session entry notice constants", () => {
  it("customType is its own kind, never reused from member messaging", () => {
    // "team-message" carries member-routing semantics and is part of the
    // exit-side team-trace check for a different reason; reusing it would
    // make the two mechanisms indistinguishable.
    expect(SESSION_ENTRY_NOTICE_CUSTOM_TYPE).toBe("team-session-notice");
    expect(SESSION_ENTRY_NOTICE_CUSTOM_TYPE).not.toBe("team-message");
  });

  it("is bounded to at most 2 turns (0 disables, 1 = strict one-shot)", () => {
    expect(SESSION_ENTRY_NOTICE_MAX_TURNS).toBe(2);
  });
});

describe("decideEntryNotice — decision table", () => {
  const base = {
    sessionActive: true,
    remaining: 2,
    hasResumeBanner: false,
    sharedContextWritten: false,
    startedMemberCount: 0,
  };

  it("an inactive session NEVER injects (mutual exclusion with the exit banner)", () => {
    for (const remaining of [0, 1, 2]) {
      expect(
        decideEntryNotice({ ...base, sessionActive: false, remaining, startedMemberCount: 2 }),
      ).toBe("none");
    }
  });

  it("an exhausted counter never injects", () => {
    for (const remaining of [0, -1]) {
      expect(decideEntryNotice({ ...base, remaining })).toBe("none");
    }
    expect(decideEntryNotice({ ...base, remaining: 0, startedMemberCount: 0 })).toBe("none");
  });

  it("injects while the team has not started working (1 and 2 turns left)", () => {
    expect(decideEntryNotice({ ...base, remaining: 1 })).toBe("inject");
    expect(decideEntryNotice({ ...base, remaining: 2 })).toBe("inject");
  });

  it("a resume banner wins: no stacking on the more specific one-shot banner", () => {
    for (const remaining of [1, 2]) {
      expect(decideEntryNotice({ ...base, remaining, hasResumeBanner: true })).toBe("none");
    }
  });

  it("stops early (clears the counter) once the team is operational", () => {
    for (const remaining of [1, 2]) {
      expect(
        decideEntryNotice({
          ...base,
          remaining,
          sharedContextWritten: true,
          startedMemberCount: 1,
        }),
      ).toBe("stop");
    }
  });

  it("a written shared context alone, or a started member alone, is not yet operational", () => {
    expect(decideEntryNotice({ ...base, sharedContextWritten: true })).toBe("inject");
    expect(decideEntryNotice({ ...base, startedMemberCount: 1 })).toBe("inject");
  });
});

describe("buildSessionEntryNotice — dispatch variant (predefined / dynamic execution)", () => {
  const notice = buildSessionEntryNotice({
    teamName: "研发队",
    sessionId: "sess-1",
    variant: "dispatch",
  });

  it("starts with the shared anchor prefix (the only string history can match)", () => {
    expect(notice.content.startsWith(SESSION_ENTRY_NOTICE_ANCHOR)).toBe(true);
    // The anchor is user-facing text, not the internal customType identifier.
    expect(SESSION_ENTRY_NOTICE_ANCHOR).not.toContain("team-session-notice");
    expect(SESSION_ENTRY_NOTICE_ANCHOR).toContain("系统通知");
  });

  it("returns the shape before_agent_start needs (customType/display/details)", () => {
    expect(notice.customType).toBe(SESSION_ENTRY_NOTICE_CUSTOM_TYPE);
    // User-invisible by decision: display only gates TUI rendering — the message
    // still enters the model context and is still persisted, which is what the
    // trace check and the exit banner rely on (contract verified against both
    // supported pi releases; see the field's doc comment).
    expect(notice.display).toBe(false);
    expect(notice.details).toEqual({
      kind: "session-entry",
      teamName: "研发队",
      sessionId: "sess-1",
      variant: "dispatch",
    });
  });

  it("declares its own source first: system notice, not user input, do not answer it", () => {
    expect(notice.content).toContain("系统通知");
    expect(notice.content).toContain("本条不是用户输入");
    expect(notice.content).toContain("不要回复本条");
  });

  it("claims authority over history and handles repeated entries", () => {
    expect(notice.content).toContain("本提示优先于对话历史");
    expect(notice.content).toContain("以最新一条为准");
  });

  it("scopes the history claim twice: before this session AND conflicting behaviour", () => {
    // Same discipline as the declaration: an absolute "every record predates
    // the entry" is false inside a team session and gets the whole prompt
    // discounted.
    expect(notice.content).toContain("进入本会话之前");
    expect(notice.content).toContain("属于普通模式");
    expect(notice.content).toContain("不构成本回合的授权");
    expect(notice.content).toContain("与本提示冲突");
    expect(notice.content).not.toContain("都发生在进入之前");
  });

  it("names the team and states the window from the constant (no drift)", () => {
    expect(notice.content).toContain("研发队");
    expect(notice.content).toContain(`前 ${SESSION_ENTRY_NOTICE_MAX_TURNS} 个回合`);
    // the number in the text is the number the counter enforces
    expect(notice.content).not.toContain("前两个回合");
  });

  it("gives an ordered action chain instead of a slogan", () => {
    const write = notice.content.indexOf("共享上下文还没写");
    const start = notice.content.indexOf("成员还没启动");
    const dispatch = notice.content.indexOf("把任务派给成员");
    expect(write).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(write);
    expect(dispatch).toBeGreaterThan(start);
    expect(notice.content).toContain("write_shared_context");
    expect(notice.content).toContain("start_member");
    expect(notice.content).toContain("team_send_and_wait");
  });

  it("keeps the 1-2 file exception and the anti-over-dispatch clause", () => {
    expect(notice.content).toContain("1-2 个文件");
    expect(notice.content).toContain("不要为闲聊强行派发");
  });
});

describe("buildSessionEntryNotice — design variant (dynamic design phase)", () => {
  const notice = buildSessionEntryNotice({
    teamName: "_dynamic_1750000000000",
    sessionId: null,
    variant: "design",
  });

  it("starts with the shared anchor prefix too", () => {
    expect(notice.content.startsWith(SESSION_ENTRY_NOTICE_ANCHOR)).toBe(true);
  });

  it("carries the variant in details (and tolerates a null session id)", () => {
    expect(notice.details.variant).toBe("design");
    expect(notice.details.sessionId).toBeNull();
  });

  it("declares its own source and authority like the dispatch variant", () => {
    expect(notice.content).toContain("本条不是用户输入");
    expect(notice.content).toContain("不要回复本条");
    expect(notice.content).toContain("本提示优先于对话历史");
    expect(notice.content).toContain("以最新一条为准");
  });

  it("scopes the history claim twice (design phase reads are legitimate)", () => {
    expect(notice.content).toContain("进入本会话之前");
    expect(notice.content).toContain("不构成本阶段的授权");
    expect(notice.content).toContain("与本提示冲突");
    expect(notice.content).not.toContain("都发生在进入之前");
  });

  it("points at the design phase and its confirmation gate", () => {
    expect(notice.content).toContain("设计阶段");
    expect(notice.content).toContain("明确确认");
    expect(notice.content).toContain("不要启动成员");
    expect(notice.content).toContain("不要派发任务");
  });

  it("names the naming step (suggested; frozen after members start)", () => {
    expect(notice.content).toContain("团队名（建议）");
    expect(notice.content).toContain("set_team_name");
    expect(notice.content).toContain("成员启动后不可改名");
    // Naming is a suggestion, never a gate in front of the confirmation flow.
    expect(notice.content).not.toContain("必须命名");
    expect(notice.content).not.toContain("不命名");
  });

  it("does NOT carry the execution dispatch chain (that would break the gate)", () => {
    expect(notice.content).not.toContain("这一回合的动作顺序");
    expect(notice.content).not.toContain("先调用 `write_shared_context`");
    expect(notice.content).not.toContain("不要为闲聊强行派发");
  });

  it("does not render the synthetic dynamic team name", () => {
    // `add_dynamic_member` legitimately contains "_dynamic_", so match the
    // synthetic session name pattern, not the bare substring.
    expect(notice.content).not.toMatch(/_dynamic_\d+/);
  });
});

// ────────────────────────────────────────────────────────────────
// Discipline matrix + static guard
//
// Both variants must carry the same three speech acts every time the text is
// edited: declare the message's own source, claim authority with a SCOPED
// history statement, and give a concrete next step. The static guard reads the
// module source so a future edit anywhere in the file (not just the two texts
// asserted above) trips the test.
// ────────────────────────────────────────────────────────────────

describe("both notice variants — discipline matrix", () => {
  const variants = [
    { variant: "dispatch" as const, teamName: "研发队" },
    { variant: "design" as const, teamName: "_dynamic_1750000000000" },
  ];

  for (const { variant, teamName } of variants) {
    const content = buildSessionEntryNotice({ teamName, sessionId: "s", variant }).content;

    it(`${variant}: first line declares the source (not user input, do not answer)`, () => {
      const firstLine = content.split("\n")[0];
      expect(firstLine).toContain("系统通知");
      expect(firstLine).toContain("本条不是用户输入");
      expect(firstLine).toContain("不要回复本条");
    });

    it(`${variant}: authority is scoped, never absolute`, () => {
      expect(content).toContain("进入本会话之前");
      expect(content).toContain("与本提示冲突");
      expect(content).not.toMatch(/都发生在进入/);
      // "一律" is only acceptable about dispatch scope, never about the
      // authority claim over history.
      expect(content).not.toMatch(/一律以本提示为准/);
    });

    it(`${variant}: states the bounded window from the constant`, () => {
      expect(content).toContain("以最新一条为准");
      if (SESSION_ENTRY_NOTICE_MAX_TURNS > 1) {
        expect(content).toContain(`前 ${SESSION_ENTRY_NOTICE_MAX_TURNS} 个回合`);
      }
    });

    it(`${variant}: gives a concrete next step (not a slogan)`, () => {
      if (variant === "dispatch") {
        expect(content).toContain("write_shared_context");
        expect(content).toContain("start_member");
        expect(content).toContain("team_send_and_wait");
      } else {
        expect(content).toContain("明确确认");
        expect(content).toContain("不要启动成员");
      }
    });
  }
});

// The absolute-quantifier pattern scan lives in src/static-scan.test.ts: it
// covers index.ts (exit banner) and every src/prompts/* module, so a prompt edit
// anywhere trips the same guard instead of only this file.
