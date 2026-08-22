import { describe, it, expect, vi } from "vitest";

// ── Mock pi-tui (same pattern as other ui tests) ──────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: vi.fn((text: string) => text.length),
}));

import {
  MemberInspectorState,
  buildSeenParents,
  mainChainEntries,
  isSinceOnMainChain,
  messageContentKey,
  precomputeContentKeys,
} from "./member-inspector-state";

// ── Fixtures ───────────────────────────────────────────────
//
// 磁盘 entry shape（spike 三源验证）：
// {type, id, parentId, timestamp, message?: {role, content, timestamp}}
// 首条 message 的 parentId 指向被 getEntries 排除的 session header（非 null、
// 不在 entries 中）——回溯时「parentId 不在映射」视为链末端（该 entry 仍在链上）。

function msgEntry(id: string, parentId: string | null, role: string, content: unknown): any {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1 },
  };
}

function nonMsgEntry(id: string, parentId: string | null, type: string): any {
  return { type, id, parentId, timestamp: "2026-01-01T00:00:00.000Z" };
}

/** 主链：session 头（不在 entries）→ a1 → a2 → a3；a2 处 fork 出旁支 x（abandoned）。 */
function makeChain(): { entries: any[]; leafId: string } {
  return {
    entries: [
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
      msgEntry("x", "a2", "user", "旁支内容"), // abandoned branch
      msgEntry("a3", "a2", "assistant", "r2"),
    ],
    leafId: "a3",
  };
}

// ── buildSeenParents / mainChainEntries ────────────────────

describe("P4 entries: main-chain filtering", () => {
  it("全量：祖先链过滤保留主链 message，剔除旁支", () => {
    const { entries, leafId } = makeChain();
    const chain = mainChainEntries(entries, leafId);
    expect(chain.map((e: any) => e.id)).toEqual(["a1", "a2", "a3"]);
    // message 内容原样保留（SessionEntry.message 为 unknown——断言处收窄）
    expect((chain[0].message as { content: string }).content).toBe("p1");
  });

  it("全量：leafId 为 null（空会话）→ 空链", () => {
    expect(mainChainEntries([msgEntry("a1", null, "user", "p1")], null)).toEqual([]);
  });

  it("全量：非 message 类型（compaction/model_change）被剔除", () => {
    const entries = [
      msgEntry("a1", "session-id", "user", "p1"),
      nonMsgEntry("c1", "a1", "compaction"),
      msgEntry("a2", "a1", "assistant", "r1"),
      nonMsgEntry("m1", "a2", "model_change"),
    ];
    const chain = mainChainEntries(entries, "m1");
    expect(chain.map((e: any) => e.id)).toEqual(["a1", "a2"]);
  });

  it("全量：首条 message parentId 指向被排除的 session 头 → 仍视为链上", () => {
    const { entries, leafId } = makeChain();
    const chain = mainChainEntries(entries, leafId);
    expect(chain.map((e: any) => e.id)).toContain("a1"); // a1.parentId = session-id 不在映射
  });

  it("全量：空 entries → 空链", () => {
    expect(mainChainEntries([], "a1")).toEqual([]);
  });

  it("增量：分叉点在 since 之前（extraParents 提供已见映射）→ 新消息并入链", () => {
    // 已见主链 a1→a2（since=a2）；新 entries 在 a2 处分叉后回主链：a3
    const seen = buildSeenParents([
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
    ]);
    const fresh = [msgEntry("a3", "a2", "assistant", "r2")];
    const chain = mainChainEntries(fresh, "a3", seen);
    expect(chain.map((e: any) => e.id)).toEqual(["a3"]);
  });

  it("增量：新 entries 含旁支（分叉点已在已见映射中）→ 旁支剔除", () => {
    const seen = buildSeenParents([
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
    ]);
    const fresh = [
      msgEntry("y", "a2", "user", "新旁支"), // fork from a2, not on new leaf chain
      msgEntry("a3", "a1", "assistant", "r2b"), // 主分支重写到 a1 之下
    ];
    // leaf=a3，祖先链 a3→a1→(session) —— a2 不在链上
    const chain = mainChainEntries(fresh, "a3", seen);
    expect(chain.map((e: any) => e.id)).toEqual(["a3"]);
  });

  it("增量：extraParents 缺失（断链）→ 仅能解析 entries 自身可达部分", () => {
    // 无 seen：a3.parentId=a2 不在映射 → a3 自身仍算链上（链末端语义）
    const chain = mainChainEntries([msgEntry("a3", "a2", "assistant", "r2")], "a3");
    expect(chain.map((e: any) => e.id)).toEqual(["a3"]);
  });
});

// ── isSinceOnMainChain（分支移动判定）──────────────────────

describe("P4 entries: since-on-main-chain detection", () => {
  it("增量安全：since 仍在主链上（直接延续）→ true", () => {
    const seen = buildSeenParents([
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
    ]);
    const fresh = [msgEntry("a3", "a2", "assistant", "r2")];
    expect(isSinceOnMainChain(seen, fresh, "a2", "a3")).toBe(true);
  });

  it("增量安全：fork 分叉点 ≤ since（steer/retry 在 since 之后）→ true", () => {
    const seen = buildSeenParents([
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
      msgEntry("a3", "a2", "user", "p2"),
    ]);
    // since=a3；新 leaf b2 从 a3 fork 出去
    const fresh = [
      msgEntry("b1", "a3", "assistant", "重写1"),
      msgEntry("b2", "b1", "user", "p2b"),
    ];
    expect(isSinceOnMainChain(seen, fresh, "a3", "b2")).toBe(true);
  });

  it("分支移动：since 不在新祖先链（主分支重写到 since 之前）→ false", () => {
    const seen = buildSeenParents([
      msgEntry("a1", "session-id", "user", "p1"),
      msgEntry("a2", "a1", "assistant", "r1"),
    ]);
    // since=a2；新 leaf 从 a1 重写（a2 被弃）
    const fresh = [msgEntry("c1", "a1", "assistant", "重写")];
    expect(isSinceOnMainChain(seen, fresh, "a2", "c1")).toBe(false);
  });

  it("分支移动：leafId 为 null → false", () => {
    const seen = buildSeenParents([msgEntry("a1", null, "user", "p1")]);
    expect(isSinceOnMainChain(seen, [], "a1", null)).toBe(false);
  });

  it("断链：回溯遇 parentId 不在映射且非 since → false（保守回退）", () => {
    const seen = buildSeenParents([msgEntry("a1", "session-id", "user", "p1")]);
    // fresh 的 parentId=a0 从未见过
    const fresh = [msgEntry("z1", "a0", "assistant", "r")];
    expect(isSinceOnMainChain(seen, fresh, "a1", "z1")).toBe(false);
  });

  it("since 为空 / 无 seen（首次全量不调用此判定）→ 保守 false", () => {
    expect(isSinceOnMainChain(new Map(), [], "", "a1")).toBe(false);
  });

  it("防环：异常 parentId 自引用不挂死（有界迭代）", () => {
    const seen = new Map<string, string | null>([["a1", "a1"]]); // 自环
    expect(isSinceOnMainChain(seen, [], "a2", "a1")).toBe(false);
  });
});

// ── R5: reconcilePending 哈希化（O(p×m) stringify → O(p+m)）──

describe("P4 R5: content hashing", () => {
  it("messageContentKey：role + content 序列化（与 sameMessageContent 语义一致）", () => {
    const a = { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    const b = { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 };
    const c = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    expect(messageContentKey(a)).toBe(messageContentKey(b)); // content 相同（timestamp 不算）
    expect(messageContentKey(a)).not.toBe(messageContentKey(c)); // role 不同
  });

  it("precomputeContentKeys：索引数组升序", () => {
    const msgs = [
      { role: "user", content: "p" },
      { role: "assistant", content: "r" },
      { role: "user", content: "p" }, // 重复内容
    ];
    const keys = precomputeContentKeys(msgs);
    expect(keys.get(messageContentKey(msgs[0]))).toEqual([0, 2]);
    expect(keys.get(messageContentKey(msgs[1]))).toEqual([1]);
  });

  it("reconcilePending 哈希化后行为等价：同内容确认 / 交错容忍 / 未确认保留", () => {
    const s = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    // 两个 pending 完成，历史含交错 toolResult
    const p1 = { role: "assistant", content: [{ type: "text", text: "完成1" }] };
    const p2 = { role: "assistant", content: [{ type: "text", text: "完成2" }] };
    s.completeLiveMessage("a", p1);
    s.completeLiveMessage("a", p2);
    s.reconcilePending("a", [
      { role: "user", content: "prompt" },
      p1,
      { role: "toolResult", content: [{ type: "toolResult", toolCallId: "1", content: "ok" }] },
      p2,
    ]);
    expect(s.tabs[0].pendingCompletions).toEqual([]);

    // 未确认保留
    s.completeLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "丢失" }] });
    s.reconcilePending("a", [{ role: "user", content: "prompt" }]);
    expect(s.tabs[0].pendingCompletions).toHaveLength(1);
  });

  it("reconcilePending 重复内容：两条相同 pending 只有一条落地 → 保留未落地的那条", () => {
    const s = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    const same = { role: "assistant", content: [{ type: "text", text: "相同" }] };
    s.completeLiveMessage("a", same);
    s.completeLiveMessage("a", { ...same, content: [{ type: "text", text: "相同" }] });
    s.reconcilePending("a", [{ role: "user", content: "prompt" }, same]);
    expect(s.tabs[0].pendingCompletions).toHaveLength(1);
    expect(s.tabs[0].pendingCompletions[0].content[0].text).toBe("相同");
  });

  it("reconcilePending 哈希路径与内容比较语义一致（content 不同 role 相同的 pending 不确认）", () => {
    const s = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    s.completeLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "A" }] });
    s.reconcilePending("a", [{ role: "assistant", content: [{ type: "text", text: "B" }] }]);
    expect(s.tabs[0].pendingCompletions).toHaveLength(1); // B ≠ A，不确认
  });
});
