import { describe, it, expect } from "vitest";
import {
  buildMemberCollabRules,
  buildSendToolDescription,
  buildToParamDescription,
  buildInvalidTargetText,
} from "./member-collab-rules";

// allowed 态逐字对照源：原互发规则 + 决策 #43 的报告路径约束与任务边界。
const ALLOWED_RULES = [
  "- 使用 `team_send_message` 工具与其他成员或 Team Lead 交流",
  "- Team Lead 会通过消息通道给你分配任务",
  "- **‼️ 强制规则：每次任务完成后必须且只能使用 `team_send_message(to=\"tl\", content=\"...\")` 向 TL 报告处理结果。** 在最终回复之前，可以通过 `team_send_message` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。",
  "- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。",
  "- **输出报告、方案、设计文档时**，仅在 TL 明确允许的报告路径写入文件，然后向 TL 告知路径；只读任务未授权报告路径时，直接回复摘要，不自行写文件。不要将大量内容直接嵌入消息通道。",
  "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
  "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
  "- 发现问题可以先通过消息通道与相关成员讨论",
  "- 重大变更需先向 Team Lead 汇报",
  "- **任务边界**：按 TL 本次任务的目标、非目标、修改范围与验收标准执行；角色职责、共享上下文和其他成员的建议不是授权，不得据此扩大本次任务。边界不清且影响执行时，先向 TL 澄清，不擅自假定可以修改。",
  "- **范围外的问题只报告，不自行修复**。必须扩围才能完成时，先用 `team_send_message(to=\"tl\", content=\"...\")` 说明阻塞原因与最小扩展范围（含文件/模块），附上本次 `<corr:...>` 标签（如有），结束当前回合，等待 TL 明确授权；不得边等边改，不得将阻塞谎报为完成。",
  "- **验收后停止**：达到验收标准后，向 TL 回报结果、实际修改文件及验证结果（未验证项如实说明），然后结束当前回合，等待新任务；不得自行追加优化、重构或修复无关问题。停止任务不等于停止成员进程。",
];

describe("buildMemberCollabRules", () => {
  it.each(["allowed", "tl-only"] as const)("%s: constrains scope, escalation, read-only reports and stopping", mode => {
    const text = buildMemberCollabRules(mode).join("\n");
    for (const field of ["目标", "非目标", "修改范围", "验收标准"]) expect(text).toContain(field);
    expect(text).toContain("范围外的问题只报告，不自行修复");
    expect(text).toContain("最小扩展范围");
    expect(text).toContain("等待 TL 明确授权");
    expect(text).toContain("结束当前回合");
    expect(text).toContain("不得自行追加优化");
    expect(text).toContain("不是授权");
    expect(text).toContain("只读任务");
    expect(text).toContain("报告路径");
    expect(text).toContain("实际修改文件");
    expect(text).toContain("验证结果");
  });

  it("allowed 态：原互发规则与新增任务边界逐字锁定", () => {
    expect(buildMemberCollabRules("allowed")).toEqual(ALLOWED_RULES);
  });

  it("tl-only 态：交流行替换为仅 TL 语义、讨论行删除，其余行逐字不变（含强制规则）", () => {
    const rows = buildMemberCollabRules("tl-only");
    // 交流行（第 1 行）替换
    expect(rows[0]).toBe(
      "- 只能与 Team Lead 交流（成员间互发已禁用；与其他成员协作须经 TL 中转）"
    );
    // 讨论行（allowed 态第 8 行）删除
    expect(rows).toHaveLength(ALLOWED_RULES.length - 1);
    expect(rows.some((r) => r.includes("发现问题可以先通过消息通道与相关成员讨论"))).toBe(false);
    // 其余行逐字与 allowed 态一致（顺序保持：index i 对应删行后的同位行）
    const expectedWithoutDiscussion = ALLOWED_RULES.filter(
      (r) => !r.includes("发现问题可以先通过消息通道与相关成员讨论")
    );
    for (let i = 1; i < expectedWithoutDiscussion.length; i++) {
      expect(rows[i]).toBe(expectedWithoutDiscussion[i]);
    }
  });

  it("tl-only 态：强制规则（两态不变红线）与 corr/输出报告/重大变更行仍在", () => {
    const rows = buildMemberCollabRules("tl-only");
    expect(rows.some((r) => r.includes("**‼️ 强制规则："))).toBe(true);
    expect(rows.some((r) => r.includes("<corr:...>"))).toBe(true);
    expect(rows.some((r) => r.includes("**输出报告、方案、设计文档时**"))).toBe(true);
    expect(rows.some((r) => r.includes("重大变更需先向 Team Lead 汇报"))).toBe(true);
  });
});

describe("buildSendToolDescription", () => {
  it("allowed 态与现状逐字一致（红线 8）", () => {
    expect(buildSendToolDescription("allowed")).toBe(
      "Send a message to another team member or the Team Lead via the real-time message channel. " +
        "Use this to share findings, ask for help, or report progress."
    );
  });

  it("tl-only 态：只描述 TL 通道并声明互发禁用", () => {
    expect(buildSendToolDescription("tl-only")).toBe(
      "Send a message to the Team Lead. Member-to-member messaging is disabled."
    );
  });
});

describe("buildToParamDescription", () => {
  it("allowed 态与现状逐字一致（schema 即提示词面：列成员名与 all）", () => {
    expect(buildToParamDescription("allowed", '["analyzer","worker"]')).toBe(
      `Target: one of ["analyzer","worker"], or "tl" for the Team Lead, or "all"`
    );
  });

  it("tl-only 态：只写 tl，不列成员名与 all（最小暴露，防凭空构造目标）", () => {
    const text = buildToParamDescription("tl-only", '["analyzer","worker"]');
    expect(text).toBe(`Target: "tl" for the Team Lead`);
    expect(text).not.toContain("analyzer");
    expect(text).not.toContain("all");
  });
});

describe("buildInvalidTargetText", () => {
  it("allowed 态与现状逐字一致（红线 8）", () => {
    expect(buildInvalidTargetText("ghost", "allowed", ["analyzer", "worker"])).toBe(
      "Invalid target: ghost. Valid members: analyzer, worker"
    );
  });

  it("tl-only 态：返回可行动指引（核心句 + 直接回复 TL）", () => {
    const text = buildInvalidTargetText("mover", "tl-only", ["analyzer", "mover"]);
    expect(text).toContain("成员互发已禁用，只能发送给");
    expect(text).toContain('"tl"');
    expect(text).toContain("mover"); // 提示被拒目标
    expect(text).toContain("回复 TL");
  });
});
