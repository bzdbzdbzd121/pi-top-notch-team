import { describe, it, expect, vi } from "vitest";
import { createRouter } from "./router";
import { createMessageQueue } from "./message-queue";
import type { TeamMessage } from "./types";

function makeMsg(overrides?: Partial<TeamMessage>): TeamMessage {
  return {
    id: "msg-1",
    from: "analyzer",
    to: "mover",
    content: "Hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("createRouter", () => {
  it("updateMembers changes valid targets", () => {
    const sendToMember = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
    });

    // Add new members
    router.updateMembers(["analyzer", "mover", "verifier"]);

    router.route(makeMsg({ from: "analyzer", to: "verifier", content: "Hi" }));
    expect(sendToMember).toHaveBeenCalledWith("verifier", expect.anything());
  });

  it("updateMembers with empty list clears targets", () => {
    const sendToMember = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
    });

    router.updateMembers([]);

    router.route(makeMsg({ from: "analyzer", to: "analyzer" }));
    // Should skip self and not send
    expect(sendToMember).not.toHaveBeenCalled();
  });


  it("routes message to a specific member", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer", "mover"] });

    router.route(makeMsg({ from: "analyzer", to: "mover", content: "Hello mover" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.objectContaining({ content: "Hello mover" }));
    expect(sendToTl).not.toHaveBeenCalled();
  });

  it("routes message to TL", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer"] });

    router.route(makeMsg({ from: "mover", to: "tl", content: "Report" }));
    expect(sendToTl).toHaveBeenCalledWith(expect.objectContaining({ content: "Report" }));
    expect(sendToMember).not.toHaveBeenCalled();
  });

  it("routes message to all members", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer", "mover"] });

    router.route(makeMsg({ from: "tl", to: "all", content: "Update" }));
    expect(sendToMember).toHaveBeenCalledTimes(2);
    expect(sendToMember).toHaveBeenCalledWith("analyzer", expect.objectContaining({ content: "Update" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.objectContaining({ content: "Update" }));
  });

  it("does not send message to self (from === to)", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer"] });

    router.route(makeMsg({ from: "analyzer", to: "analyzer" }));
    expect(sendToMember).not.toHaveBeenCalled();
  });

  it("calls onUnknownTarget for unknown target", () => {
    const onUnknownTarget = vi.fn();
    const router = createRouter({
      sendToMember: vi.fn(),
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
      onUnknownTarget,
    });

    router.route(makeMsg({ from: "analyzer", to: "nonexistent" }));
    expect(onUnknownTarget).toHaveBeenCalledWith("analyzer", "nonexistent");
  });
});

describe("peer-messaging policy（P2 路由强制层）", () => {
  const members = ["analyzer", "mover"];

  it("红线 9 fail-open：isPeerMessagingAllowed 缺省（undefined）→ 恒允许（零行为变化路径）", () => {
    const sendToMember = vi.fn();
    const router = createRouter({ sendToMember, sendToTl: vi.fn(), memberNames: members });
    router.route(makeMsg({ from: "analyzer", to: "mover" }));
    expect(sendToMember).toHaveBeenCalledTimes(1);
  });

  it("允许态（resolver=true）→ member→member 照常送达（红线 8 允许态零回归）", () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => true,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "analyzer", to: "mover" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.anything());
    expect(onPeerBlocked).not.toHaveBeenCalled();
  });

  it("禁用态：member→member 被拦（sendToMember 不调用，onPeerBlocked 触发）", () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "analyzer", to: "mover" }));
    expect(sendToMember).not.toHaveBeenCalled();
    expect(onPeerBlocked).toHaveBeenCalledWith("analyzer", "mover");
  });

  it("禁用态：member→all 被拦（all 分支只广播成员不含 TL，放行即 n-1 条互发通道）", () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "analyzer", to: "all" }));
    expect(sendToMember).not.toHaveBeenCalled();
    expect(onPeerBlocked).toHaveBeenCalledWith("analyzer", "all");
  });

  it("红线 1（最高优先级）：禁用态 TL 派发照常通过（from=tl→member 与 from=tl→all）", () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "tl", to: "mover", content: "任务派发" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.anything());
    router.route(makeMsg({ from: "tl", to: "all", content: "广播" }));
    // all 分支广播给全部成员（不含 TL 自己）：2 个成员都收到
    expect(sendToMember).toHaveBeenCalledTimes(3);
    expect(onPeerBlocked).not.toHaveBeenCalled();
  });

  it("红线 4：禁用态 member→TL 照常送达（to=tl 分支先行，resolver 不被调用）", () => {
    const sendToTl = vi.fn();
    const isPeerMessagingAllowed = vi.fn(() => false);
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember: vi.fn(),
      sendToTl,
      memberNames: members,
      isPeerMessagingAllowed,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "analyzer", to: "tl", content: "Report" }));
    expect(sendToTl).toHaveBeenCalledWith(expect.objectContaining({ content: "Report" }));
    expect(onPeerBlocked).not.toHaveBeenCalled();
    // to=tl 不在互发目标域内：resolver 恒不被调用（corr 自动补全在入队点已完成，与 router 无关）
    expect(isPeerMessagingAllowed).not.toHaveBeenCalled();
  });

  it("红线 5：unknown 目标语义解耦——禁用态 member→ghost 不走 policy 拦截，仍 onUnknownTarget", () => {
    const onUnknownTarget = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember: vi.fn(),
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
      onUnknownTarget,
      onPeerBlocked,
    });
    router.route(makeMsg({ from: "analyzer", to: "ghost" }));
    expect(onUnknownTarget).toHaveBeenCalledWith("analyzer", "ghost");
    expect(onPeerBlocked).not.toHaveBeenCalled();
  });

  it("onPeerBlocked 缺省 → 静默丢弃（不 throw，只有拦截无通知）", () => {
    const sendToMember = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
    });
    expect(() => router.route(makeMsg({ from: "analyzer", to: "mover" }))).not.toThrow();
    expect(sendToMember).not.toHaveBeenCalled();
  });

  it("红线 2：工具路径与正文标签路径同入 route()——两进队形判均被拦（真实 queue 集成）", async () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: members,
      isPeerMessagingAllowed: () => false,
      onPeerBlocked,
    });
    const mq = createMessageQueue(async (msg) => {
      router.route(msg);
    });
    // 工具路径（team_send_message → tool_execution_end → enqueue）的入队形态
    mq.enqueue(makeMsg({ id: "tool-1", from: "analyzer", to: "mover" }));
    // 正文标签备份路径（assistant 正文 <team-message> → message_end → enqueue）——
    // 相同 TeamMessage 形态、不同进队点，此后完全共享同一条 route() 路径
    mq.enqueue(makeMsg({ id: "tag-1", from: "analyzer", to: "mover" }));
    await mq.drain();
    mq.stop();
    expect(sendToMember).not.toHaveBeenCalled();
    expect(onPeerBlocked).toHaveBeenCalledTimes(2);
  });

  it("updateMembers 后新成员也是有效拦截目标（memberSet 刷新语义）", () => {
    const sendToMember = vi.fn();
    const onPeerBlocked = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
      isPeerMessagingAllowed: () => false,
      onPeerBlocked,
    });
    router.updateMembers(["analyzer", "newcomer"]);
    router.route(makeMsg({ from: "analyzer", to: "newcomer" }));
    expect(onPeerBlocked).toHaveBeenCalledWith("analyzer", "newcomer");
    expect(sendToMember).not.toHaveBeenCalled();
  });
});
