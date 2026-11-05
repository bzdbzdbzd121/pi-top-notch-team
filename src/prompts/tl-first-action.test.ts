import { describe, it, expect } from "vitest";
import {
  buildFirstActionProtocolPrompt,
  type FirstActionProtocolOptions,
} from "./tl-first-action";

/**
 * The protocol previously stated TWO different "your first tool call must be…"
 * rules in the same list (write_shared_context vs start_member/team_send_and_wait)
 * and never mentioned start_member at all — while /team start does not launch
 * members, so a dispatch without start_member hits "目标成员不存在或未启动".
 *
 * It is now one ordered chain. These assertions lock that shape in ALL THREE
 * runtime states (默认 / 自定义上限 / 关闭): the reminder work in later stages
 * points the model at this chain, so it must be executable, not self-contradictory.
 */
const STATES: Array<{ label: string; opts: FirstActionProtocolOptions }> = [
  { label: "默认（开启、3 次）", opts: { enabled: true, threshold: 3 } },
  { label: "自定义上限（开启、7 次）", opts: { enabled: true, threshold: 7 } },
  { label: "关闭", opts: { enabled: false, threshold: 3 } },
];

describe("buildFirstActionProtocolPrompt — 三态共有的结构", () => {
  for (const { label, opts } of STATES) {
    it(`${label}：「第一个工具调用」只出现一次（旧的并行双规则已消除）`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      const hits = prompt.match(/第一个工具调用/g) ?? [];
      expect(hits).toHaveLength(1);
    });

    it(`${label}：三步有序链 — 写共享上下文 → 启动成员 → 派发任务`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      const step1 = prompt.indexOf("**还没写共享上下文**");
      const step2 = prompt.indexOf("**需要的成员还没启动**");
      const step3 = prompt.indexOf("**派发任务**");

      expect(step1).toBeGreaterThan(-1);
      expect(step2).toBeGreaterThan(step1);
      expect(step3).toBeGreaterThan(step2);
    });

    it(`${label}：三个工具名均可检出（含旧版漏掉的 start_member）`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      expect(prompt).toContain("write_shared_context");
      expect(prompt).toContain("start_member");
      expect(prompt).toContain("team_send_and_wait");
    });

    it(`${label}：保留派发前禁止自身分析的硬规则`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      expect(prompt).toContain("禁止 read / bash 代码文件");
      expect(prompt).toContain("角色就已经偏了");
    });

    it(`${label}：保留 1-2 文件的需求对齐例外（策略未收紧）`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      expect(prompt).toContain("允许读取 1-2 个文件");
    });

    it(`${label}：保留 start_member 硬门控说明（与开关无关，永远成立）`, () => {
      const prompt = buildFirstActionProtocolPrompt(opts);
      expect(prompt).toContain("未写入前 `start_member` 会被系统拦截");
    });
  }
});

describe("运行时检测段 — 必须与真实行为一致", () => {
  it("默认（3）：含「超过 3 次」与「持续拦截」", () => {
    const prompt = buildFirstActionProtocolPrompt({ enabled: true, threshold: 3 });
    expect(prompt).toContain("超过 3 次");
    expect(prompt).toContain("持续拦截");
  });

  it("上限 7：含「超过 7 次」、不含「超过 3 次」（数字参数化，不留旧值）", () => {
    const prompt = buildFirstActionProtocolPrompt({ enabled: true, threshold: 7 });
    expect(prompt).toContain("超过 7 次");
    expect(prompt).not.toContain("超过 3 次");
  });

  it("关闭：不含「持续拦截」与「超过 … 次」，也不声称「已关闭」", () => {
    const prompt = buildFirstActionProtocolPrompt({ enabled: false, threshold: 3 });
    // 关闭后运行时根本不拦，任何「会拦截」的陈述都是可被一次工具调用证伪的假话
    expect(prompt).not.toContain("持续拦截");
    expect(prompt).not.toMatch(/超过\s*\d+\s*次/);
    expect(prompt).not.toContain("运行时检测");
    // 也不写「限制已关闭」这类关于设置的陈述（对模型无价值，且把提示词绑到配置细节）
    expect(prompt).not.toContain("已关闭");
  });

  it("关闭：行为规则与硬门控仍在（不是删掉整段协议）", () => {
    const prompt = buildFirstActionProtocolPrompt({ enabled: false, threshold: 3 });
    expect(prompt).toContain("禁止 read / bash 代码文件");
    expect(prompt).toContain("允许读取 1-2 个文件");
    expect(prompt).toContain("未写入前 `start_member` 会被系统拦截");
  });
});

describe("提示词不携带绝对化历史断言（仓内静态扫描守卫）", () => {
  it("三态都不对「历史里的团队痕迹」下全称断言", () => {
    for (const { opts } of STATES) {
      const prompt = buildFirstActionProtocolPrompt(opts);
      expect(prompt).not.toMatch(/(所有|全部|一切)[^。；\n]{0,20}(历史|记录)/);
    }
  });
});
