import { describe, it, expect } from "vitest";
import { FIRST_ACTION_PROTOCOL_PROMPT } from "./tl-first-action";

/**
 * The protocol previously stated TWO different "your first tool call must be…"
 * rules in the same list (write_shared_context vs start_member/team_send_and_wait)
 * and never mentioned start_member at all — while /team start does not launch
 * members, so a dispatch without start_member hits "目标成员不存在或未启动".
 *
 * It is now one ordered chain. These assertions lock that shape: the reminder
 * work in later stages points the model at this chain, so it must be
 * executable, not self-contradictory.
 */
describe("FIRST_ACTION_PROTOCOL_PROMPT", () => {
  it("「第一个工具调用」只出现一次（旧的并行双规则已消除）", () => {
    const hits = FIRST_ACTION_PROTOCOL_PROMPT.match(/第一个工具调用/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it("三步有序链：写共享上下文 → 启动成员 → 派发任务", () => {
    const step1 = FIRST_ACTION_PROTOCOL_PROMPT.indexOf("**还没写共享上下文**");
    const step2 = FIRST_ACTION_PROTOCOL_PROMPT.indexOf("**需要的成员还没启动**");
    const step3 = FIRST_ACTION_PROTOCOL_PROMPT.indexOf("**派发任务**");

    expect(step1).toBeGreaterThan(-1);
    expect(step2).toBeGreaterThan(step1);
    expect(step3).toBeGreaterThan(step2);
  });

  it("三个工具名均可检出（补齐旧版漏掉的 start_member）", () => {
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("write_shared_context");
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("start_member");
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("team_send_and_wait");
  });

  it("保留派发前禁止自身分析的硬规则", () => {
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("禁止 read / bash 代码文件");
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("角色就已经偏了");
  });

  it("保留 1-2 文件的需求对齐例外（策略未收紧）", () => {
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("允许读取 1-2 个文件");
  });

  it("保留运行时检测的威慑说明（第 4 次起持续拦截）", () => {
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("超过 3 次");
    expect(FIRST_ACTION_PROTOCOL_PROMPT).toContain("持续拦截");
  });
});
