import { describe, it, expect } from "vitest";
import { buildDynamicModePrompt } from "./dynamic-mode";
import type { TeamDefinition } from "../team/definition";
import { DESIGN_READ_GUARD_THRESHOLD } from "../settings/tl-self-work-guard-constants";

/** 所有用例显式传三态（`selfWorkGuard` 必填——省略不得冒充「开启+3」）。 */
const DEFAULT_GUARD = { enabled: true, threshold: 3 } as const;

function buildPrompt(
  team: TeamDefinition,
  phase: "design" | "execution",
  sessionId?: string | null,
  selfWorkGuard: { enabled: boolean; threshold: number } = DEFAULT_GUARD
): string {
  return buildDynamicModePrompt(team, phase, sessionId ?? null, { selfWorkGuard });
}

// Ordering assertions anchor on the protocol BLOCK HEADING, not the bare phrase
// "第一动作协议": since decision #47 the state declaration at the top of the
// team block also names the protocol ("收到任务型诉求时先按第一动作协议派发"),
// so a bare-phrase indexOf hits that mention instead. The assertion would still
// pass — but it would measure the declaration, not the protocol block, and stay
// green even if the block moved below the 铁律 section.
const PROTOCOL_HEADING = "### 🚨 最高优先级：第一动作协议";


const emptyTeam: TeamDefinition = {
  name: "_dynamic_test",
  description: "测试动态团队",
  members: [],
};

const teamWithMembers: TeamDefinition = {
  ...emptyTeam,
  members: [
    { name: "coder", label: "编码员", systemPrompt: "你是一个高级程序员，负责实现代码。" },
    { name: "reviewer", label: "审查员", systemPrompt: "你是一个代码审查专家，负责审查实现。" },
  ],
};

describe("buildDynamicModePrompt — design phase", () => {
  const prompt = buildPrompt(emptyTeam, "design", "sess-1");

  it("标注为设计阶段", () => {
    expect(prompt).toContain("设计阶段");
  });

  it("包含六阶段设计流程", () => {
    expect(prompt).toContain("阶段 A：需求对齐");
    expect(prompt).toContain("阶段 B：任务拆分");
    expect(prompt).toContain("阶段 C：工作流编排与质量加固");
    expect(prompt).toContain("阶段 D：团队设计");
    expect(prompt).toContain("阶段 E：方案确认门");
    expect(prompt).toContain("阶段 F：落地执行");
  });

  it("包含确认门硬性规则（用户确认前禁止注册/启动成员）", () => {
    expect(prompt).toContain("禁止调用 `add_dynamic_member` 和 `start_member`");
  });

  it("注入 orchestration playbook 内容", () => {
    // playbook 的关键标志内容
    expect(prompt).toContain("TL 编排方法论 Playbook");
    expect(prompt).toContain("并行冗余 + 交叉验证");
    expect(prompt).toContain("对抗辩论");
    expect(prompt).toContain("开发-审核循环");
    expect(prompt).toContain("默认假设：agent 会犯错");
    expect(prompt).toContain("分批循环处理");
  });

  it("playbook 计划书模板含「团队名（建议）」字段，规则标注建议语义与不可改名", () => {
    expect(prompt).toContain("### 团队名（建议）");
    expect(prompt).toContain("不是开工条件");
    expect(prompt).toContain("成员启动后不能再改名");
  });

  it("阶段 E 的字段枚举与 playbook 计划书模板一致（防漂移）", () => {
    // Extract the fields the model is told to put in the plan document, then
    // require every one of them to be enumerated at stage E — otherwise the
    // confirmation gate would show a plan without that field (and the name
    // freezes right after start_member).
    const templateHeading = "### 计划书模板";
    const template = prompt.slice(
      prompt.indexOf(templateHeading) + templateHeading.length,
      prompt.indexOf("### 规则")
    );
    const fields = template
      .split("\n")
      .filter((line) => line.startsWith("### "))
      .map((line) => line.slice(4).trim());
    expect(fields).toEqual([
      "目标",
      "任务拆分",
      "工作流",
      "团队分工",
      "团队名（建议）",
      "风险与应对",
    ]);

    const stageE = prompt.slice(
      prompt.indexOf("#### 阶段 E：方案确认门"),
      prompt.indexOf("#### 阶段 F：落地执行")
    );
    for (const field of fields) {
      expect(stageE, `阶段 E 缺少计划书字段：${field}`).toContain(field);
    }
  });

  it("阶段 F 落地顺序：命名 → 注册成员 → 写共享上下文 → 启动成员（阶段 5）", () => {
    const fStart = prompt.indexOf("#### 阶段 F：落地执行");
    const fEnd = prompt.indexOf("#### 目标（可选）");
    expect(fStart).toBeGreaterThan(-1);
    expect(fEnd).toBeGreaterThan(fStart);
    const fSection = prompt.slice(fStart, fEnd);

    expect(fSection).toContain("set_team_name");
    expect(fSection).toContain("建议");
    expect(fSection).toContain("成员启动后不能再改名");
    // The freeze point is start_member, never add_dynamic_member.
    expect(fSection).toContain("启动成员之前");

    const setNameIdx = fSection.indexOf("set_team_name");
    const addIdx = fSection.indexOf("add_dynamic_member");
    const ctxIdx = fSection.indexOf("write_shared_context");
    expect(setNameIdx).toBeGreaterThan(-1);
    expect(setNameIdx).toBeLessThan(addIdx);
    expect(addIdx).toBeLessThan(ctxIdx);
  });

  it("只能做的操作清单里包含 set_team_name", () => {
    const ops = prompt.slice(
      prompt.indexOf("你只能做的操作"),
      prompt.indexOf("### 设计流程")
    );
    expect(ops).toContain("set_team_name");
    expect(ops).toContain("启动成员前完成");
  });

  it("命名不是硬门控（负例锁）：无「必须命名」「不命名会被拦」类措辞", () => {
    expect(prompt).not.toContain("必须命名");
    expect(prompt).not.toContain("不命名");
    expect(prompt).not.toMatch(/未命名[^。\n]*(拦截|禁止)/);
    expect(prompt).not.toContain("禁止调用 `set_team_name`");
    // 确认门仍只针对注册/启动成员（既有约束不得被改写稀释或扩大）
    expect(prompt).toContain("禁止调用 `add_dynamic_member` 和 `start_member`");
  });

  it("包含设计阶段铁律（工具硬阻断说明 + read 软限制）", () => {
    expect(prompt).toContain("铁律");
    expect(prompt).toContain("bash");
    // read 是允许的（软限制），不再是硬阻断
    expect(prompt).not.toContain("不能读取任何文件");
    expect(prompt).toContain("✅ read");
    expect(prompt).toContain("再次调用 read 即可放行");
  });

  it("不列举第三方编排工具 ask_user_question / todo（发现性交给工具自身提示词）", () => {
    // 决策 #44：白名单放行这两件第三方工具，但本扩展的提示词不提及它们——
    // 第三方工具由其自身 promptSnippet/promptGuidelines 负责发现性。
    // 负例锁定，防止无意间把第三方工具重新写回提示词。
    expect(prompt).not.toContain("ask_user_question");
    expect(prompt).not.toContain("todo");
  });

  it("空团队时提示使用 add_dynamic_member", () => {
    expect(prompt).toContain("add_dynamic_member");
    expect(prompt).toContain("尚无成员");
  });

  it("展示已注册成员", () => {
    const p = buildPrompt(teamWithMembers, "design");
    expect(p).toContain("coder（编码员）");
    expect(p).toContain("reviewer（审查员）");
  });
});

describe("buildDynamicModePrompt — 常驻状态声明（阶段 0）", () => {
  it("设计阶段：注入设计态声明，位置在设计阶段正文之前", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1");
    const idxDecl = prompt.indexOf("状态：你正在团队会话中（动态团队 — 设计阶段）");
    const idxPhase = prompt.indexOf("═══ 设计阶段 — 你的角色 ═══");
    expect(idxDecl).toBeGreaterThan(-1);
    expect(idxPhase).toBeGreaterThan(-1);
    expect(idxDecl).toBeLessThan(idxPhase);
  });

  it("设计阶段：声明含确认门，不含执行态的派发链与纠正措辞", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1");
    expect(prompt).toContain("明确确认");
    expect(prompt).toContain("当前唯一有效的状态");
    // 执行态专属措辞不得渗入设计态（否则提示模型在确认门前派发）
    expect(prompt).not.toContain("立即停下并改为派发");
  });

  it("执行阶段：注入执行态声明，位置在第一动作协议之前", () => {
    const prompt = buildPrompt(teamWithMembers, "execution");
    const idxDecl = prompt.indexOf("状态：你正在团队会话中（Team Lead）");
    const idxProtocol = prompt.indexOf(PROTOCOL_HEADING);
    expect(idxDecl).toBeGreaterThan(-1);
    expect(idxProtocol).toBeGreaterThan(-1);
    expect(idxDecl).toBeLessThan(idxProtocol);
    expect(prompt).toContain("当前唯一有效的状态");
    expect(prompt).toContain("立即停下并改为派发");
  });
});

describe("buildDynamicModePrompt — goal closing protocol", () => {
  it("design phase lists goal tools (set_goal/finish_goal)", () => {
    const prompt = buildPrompt(emptyTeam, "design");
    expect(prompt).toContain("set_goal");
    expect(prompt).toContain("finish_goal");
  });

  it("execution phase lists goal tools and mandates the closing protocol", () => {
    const prompt = buildPrompt(teamWithMembers, "execution");
    expect(prompt).toContain("set_goal");
    expect(prompt).toContain("finish_goal");
    // 收尾协议：完成/阻塞 → 强制调用 finish_goal，禁止仅口头宣称
    expect(prompt).toContain("调用 \`finish_goal\`");
    expect(prompt).toContain("禁止仅口头宣称");
    // 顺序：汇总并验证（不结束回合）→ finish_goal → 向用户最终汇报 → /team stop
    const verifyIdx = prompt.indexOf("汇总并验证");
    const finishIdx = prompt.indexOf("调用 \`finish_goal\`");
    const reportIdx = prompt.indexOf("向用户汇报最终结果");
    const stopIdx = prompt.indexOf("/team stop");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(finishIdx);
    expect(finishIdx).toBeLessThan(reportIdx);
    expect(reportIdx).toBeLessThan(stopIdx);
  });
});

describe("buildDynamicModePrompt — execution phase", () => {
  const prompt = buildPrompt(teamWithMembers, "execution");

  it("标注为执行阶段", () => {
    expect(prompt).toContain("执行阶段");
  });

  it("包含铁律：不做 Member 能做的事", () => {
    expect(prompt).toContain("铁律");
    expect(prompt).toContain("绝不能自己做");
  });

  it("包含第一动作协议（有序链），且位于铁律段落之前", () => {
    expect(prompt).toContain("第一动作协议");
    expect(prompt).toContain("**还没写共享上下文**");
    expect(prompt).toContain("**需要的成员还没启动**");
    expect(prompt).toContain("**派发任务**");
    const idxProtocol = prompt.indexOf(PROTOCOL_HEADING);
    const idxIronRule = prompt.indexOf("铁律：你绝不能自己做");
    expect(idxProtocol).toBeGreaterThan(-1);
    expect(idxIronRule).toBeGreaterThan(-1);
    expect(idxProtocol).toBeLessThan(idxIronRule);
  });

  it("不注入 playbook（playbook 仅设计阶段使用）", () => {
    expect(prompt).not.toContain("TL 编排方法论 Playbook");
  });

  it("不列举第三方编排工具 ask_user_question / todo（决策 #44）", () => {
    expect(prompt).not.toContain("ask_user_question");
    expect(prompt).not.toContain("todo");
  });
});

// ── 阶段 3：TL 亲自分析限制的两态一致性（提示词不得与运行时不符）──────

describe("buildDynamicModePrompt — TL 亲自分析限制（设计阶段）", () => {
  it("开启（默认）：含「每 4 次」软提醒说明", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1");
    expect(prompt).toContain("每 4 次");
    expect(prompt).toContain("直接再次调用 read 即可放行");
  });

  it("显式开启：与缺省一致（参数化不改变节奏）", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1", { enabled: true, threshold: 7 });
    // 设计阶段的节奏固定 4，不受执行阶段次数影响
    expect(prompt).toContain("每 4 次");
    expect(prompt).not.toContain("每 7 次");
  });

  it("关闭：不含「每 4 次」与频率提醒措辞", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1", { enabled: false, threshold: 3 });
    expect(prompt).not.toContain("每 4 次");
    expect(prompt).not.toContain("频率提醒");
    expect(prompt).not.toContain("拦截一次并提醒");
  });

  it("两态都保留：.md 不限制 + 代码分析留给执行阶段的 Member", () => {
    for (const enabled of [true, false]) {
      const prompt = buildPrompt(emptyTeam, "design", "sess-1", { enabled, threshold: 3 });
      expect(prompt).toContain("不限制 .md 文档");
      expect(prompt).toContain("代码分析留给执行阶段的 Member");
    }
  });
});

describe("buildDynamicModePrompt — TL 亲自分析限制（执行阶段）", () => {
  it("默认：含「超过 3 次」与「持续拦截」", () => {
    const prompt = buildPrompt(teamWithMembers, "execution");
    expect(prompt).toContain("超过 3 次");
    expect(prompt).toContain("持续拦截");
  });

  it("上限 7：含「超过 7 次」、不含「超过 3 次」", () => {
    const prompt = buildPrompt(teamWithMembers, "execution", null, { enabled: true, threshold: 7 });
    expect(prompt).toContain("超过 7 次");
    expect(prompt).not.toContain("超过 3 次");
  });

  it("关闭：不含「持续拦截」，但行为规则与硬门控保留", () => {
    const prompt = buildPrompt(teamWithMembers, "execution", null, { enabled: false, threshold: 3 });
    expect(prompt).not.toContain("持续拦截");
    expect(prompt).toContain("禁止 read / bash 代码文件");
    expect(prompt).toContain("允许读取 1-2 个文件");
    expect(prompt).toContain("未写入前 `start_member` 会被系统拦截");
  });
});

// ── 阶段 3 审查：必填参数 / 节奏常量插值 / 关闭态句式 ─────────────────

describe("buildDynamicModePrompt — 参数与文案细则（阶段 3 审查）", () => {
  it("selfWorkGuard 必填：省略 opts 即编译期失败（不得用默认值冒充真实配置）", () => {
    // @ts-expect-error selfWorkGuard 为必填字段——省略会渲染「开启+3」，与真实配置可能不符
    const build = () => buildDynamicModePrompt(emptyTeam, "design", "sess-1", {});
    // 运行时同样不静默退回默认：缺字段直接抛（响亮失败优于渲染假话）
    expect(build).toThrow();
  });

  it("设计阶段「每 N 次」由 DESIGN_READ_GUARD_THRESHOLD 插值（联动断言，防硬编码漂移）", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1", DEFAULT_GUARD);
    expect(prompt).toContain(`每 ${DESIGN_READ_GUARD_THRESHOLD} 次`);
    expect(DESIGN_READ_GUARD_THRESHOLD).toBe(4);
  });

  it("设计阶段关闭态无重复标点（「）；（」），句式自洽", () => {
    const prompt = buildPrompt(emptyTeam, "design", "sess-1", { enabled: false, threshold: 3 });
    expect(prompt).not.toContain("）；（");
    expect(prompt).toContain("读取次数不受提醒限制");
    // 两态共同的 read 行结构不变
    expect(prompt).toContain("不限制 .md 文档");
    expect(prompt).toContain("代码分析留给执行阶段的 Member");
  });
});
