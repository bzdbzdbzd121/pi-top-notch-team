import { describe, it, expect } from "vitest";
import {
  buildMemberCollabRules,
  buildSendToolDescription,
  buildToParamDescription,
  buildInvalidTargetText,
} from "./member-collab-rules";

// member.ts 旧内联模板的协作规则行（allowed 态逐字对照源，红线 8）。
const ALLOWED_RULES = [
  "- 使用 `team_send_message` 工具与其他成员或 Team Lead 交流",
  "- Team Lead 会通过消息通道给你分配任务",
  "- **‼️ 强制规则：每次任务完成后必须且只能使用 `team_send_message(to=\"tl\", content=\"...\")` 向 TL 报告处理结果。** 在最终回复之前，可以通过 `team_send_message` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。",
  "- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。",
  "- **输出报告、方案、设计文档时，写入文件**（放在项目目录下），然后在消息中告知其他成员文件路径。不要将大量内容直接嵌入消息通道。",
  "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
  "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
  "- 发现问题可以先通过消息通道与相关成员讨论",
  "- 重大变更需先向 Team Lead 汇报",
];

describe("buildMemberCollabRules", () => {
  it("allowed 态：与现状 9 行逐字一致（红线 8 零回归）", () => {
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
    expect(rows.some((r) => r.includes("**输出报告、方案、设计文档时，写入文件**"))).toBe(true);
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
