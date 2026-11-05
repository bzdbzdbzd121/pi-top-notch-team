import { describe, it, expect } from "vitest";
import { buildDynamicModePrompt } from "./dynamic-mode";
import type { TeamDefinition } from "../team/definition";

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
  const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1");

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
    const p = buildDynamicModePrompt(teamWithMembers, "design");
    expect(p).toContain("coder（编码员）");
    expect(p).toContain("reviewer（审查员）");
  });
});

describe("buildDynamicModePrompt — 常驻状态声明（阶段 0）", () => {
  it("设计阶段：注入设计态声明，位置在设计阶段正文之前", () => {
    const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1");
    const idxDecl = prompt.indexOf("状态：你正在团队会话中（动态团队 — 设计阶段）");
    const idxPhase = prompt.indexOf("═══ 设计阶段 — 你的角色 ═══");
    expect(idxDecl).toBeGreaterThan(-1);
    expect(idxPhase).toBeGreaterThan(-1);
    expect(idxDecl).toBeLessThan(idxPhase);
  });

  it("设计阶段：声明含确认门，不含执行态的派发链与纠正措辞", () => {
    const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1");
    expect(prompt).toContain("明确确认");
    expect(prompt).toContain("当前唯一有效的状态");
    // 执行态专属措辞不得渗入设计态（否则提示模型在确认门前派发）
    expect(prompt).not.toContain("立即停下并改为派发");
  });

  it("执行阶段：注入执行态声明，位置在第一动作协议之前", () => {
    const prompt = buildDynamicModePrompt(teamWithMembers, "execution");
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
    const prompt = buildDynamicModePrompt(emptyTeam, "design");
    expect(prompt).toContain("set_goal");
    expect(prompt).toContain("finish_goal");
  });

  it("execution phase lists goal tools and mandates the closing protocol", () => {
    const prompt = buildDynamicModePrompt(teamWithMembers, "execution");
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
  const prompt = buildDynamicModePrompt(teamWithMembers, "execution");

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
    const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1");
    expect(prompt).toContain("每 4 次");
    expect(prompt).toContain("直接再次调用 read 即可放行");
  });

  it("显式开启：与缺省一致（参数化不改变节奏）", () => {
    const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1", {
      selfWorkGuard: { enabled: true, threshold: 7 },
    });
    // 设计阶段的节奏固定 4，不受执行阶段次数影响
    expect(prompt).toContain("每 4 次");
    expect(prompt).not.toContain("每 7 次");
  });

  it("关闭：不含「每 4 次」与频率提醒措辞", () => {
    const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1", {
      selfWorkGuard: { enabled: false, threshold: 3 },
    });
    expect(prompt).not.toContain("每 4 次");
    expect(prompt).not.toContain("频率提醒");
    expect(prompt).not.toContain("拦截一次并提醒");
  });

  it("两态都保留：.md 不限制 + 代码分析留给执行阶段的 Member", () => {
    for (const enabled of [true, false]) {
      const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1", {
        selfWorkGuard: { enabled, threshold: 3 },
      });
      expect(prompt).toContain("不限制 .md 文档");
      expect(prompt).toContain("代码分析留给执行阶段的 Member");
    }
  });
});

describe("buildDynamicModePrompt — TL 亲自分析限制（执行阶段）", () => {
  it("默认：含「超过 3 次」与「持续拦截」", () => {
    const prompt = buildDynamicModePrompt(teamWithMembers, "execution");
    expect(prompt).toContain("超过 3 次");
    expect(prompt).toContain("持续拦截");
  });

  it("上限 7：含「超过 7 次」、不含「超过 3 次」", () => {
    const prompt = buildDynamicModePrompt(teamWithMembers, "execution", null, {
      selfWorkGuard: { enabled: true, threshold: 7 },
    });
    expect(prompt).toContain("超过 7 次");
    expect(prompt).not.toContain("超过 3 次");
  });

  it("关闭：不含「持续拦截」，但行为规则与硬门控保留", () => {
    const prompt = buildDynamicModePrompt(teamWithMembers, "execution", null, {
      selfWorkGuard: { enabled: false, threshold: 3 },
    });
    expect(prompt).not.toContain("持续拦截");
    expect(prompt).toContain("禁止 read / bash 代码文件");
    expect(prompt).toContain("允许读取 1-2 个文件");
    expect(prompt).toContain("未写入前 `start_member` 会被系统拦截");
  });
});
