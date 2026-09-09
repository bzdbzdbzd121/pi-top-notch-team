import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberProcessHandle } from "../process/member-process";
import type { MemberOperationalState } from "../session/context";
import { createRouter } from "../channel/router";
import type { Router } from "../channel/router";
import { createMessageQueue } from "../channel/message-queue";
import type { MessageQueue } from "../channel/message-queue";
import { createResponseWaiter, extractCorrelationId } from "../channel/response-waiter";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { TeamMessage } from "../channel/types";
import { createSendToMember, dispatchPromptTextToMember } from "../channel/event-handler";
import { createAutoCompactRuntime } from "../channel/auto-compact";
import type { AutoCompactRuntime } from "../channel/auto-compact";
import { createMessageCoalescer } from "../channel/message-coalescer";
import type { MessageCoalescer } from "../channel/message-coalescer";
import { createTlWaitGate } from "../channel/tl-wait-gate";
import type { TlWaitGate } from "../channel/tl-wait-gate";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import type { ResolvedMessageCoalescing } from "../settings/resolve-message-coalescing";

// ── Dependency Injection Interface ─────────────────────────

export interface MessageChannelDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  lastPendingCorrId: Map<string, string>;
  memberHandles: Map<string, MemberProcessHandle>;
  /** UI-only notification callback for successful message routing. */
  onRouteNotification?: (target: string) => void;
  /** Resolve the effective Auto-Compaction config (per dispatch). Absent = disabled. */
  getAutoCompact?: () => ResolvedAutoCompact;
  /** Resolve the effective message-coalescing config (per dispatch). Absent = defaults (enabled). */
  getCoalescing?: () => ResolvedMessageCoalescing;
  /**
   * Resolve the peer-messaging policy (P2, per-route 即时生效，与 getAutoCompact /
   * getCoalescing 同构）。false = 该团队已禁用成员互发。Absent = 恒允许
   * （router 侧 fail-open 缺省路径；resolver 自身异常的 fail-open 在设置层
   * resolvePeerMessaging 内闭合）。
   */
  getPeerMessagingAllowed?: () => boolean;
}

export interface MessageChannel {
  router: Router;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  /**
   * The single shared auto-compaction runtime for this channel. Both the
   * inline dispatch path (sendToMember) and the batch pre-check barrier
   * (tl-tools) compose it, so pending/flush is shared across paths.
   */
  autoCompact: AutoCompactRuntime;
  /**
   * The single shared message coalescer for this channel (S1, 阶段 2). The
   * dispatch entry (createSendToMember) enqueues/flushes and the member
   * event handlers (agent_end / compaction_end / process_exit) flush/drain
   * the SAME instance — bucket state is never split across paths.
   */
  coalescer: MessageCoalescer;
  /**
   * The TL wait gate (S3): buffers member→TL messages while a
   * team_send_and_wait wait is in flight; the wait flushes them via steer
   * the moment the all-idle gate opens (decision #38/39) — no waiting for
   * the TL's turn to end (pi nextTurn queue).
   */
  tlWaitGate: TlWaitGate;
}

// ── createMessageChannel ───────────────────────────────────
// Creates the message channel infrastructure:
//   1. responseWaiter — for team_send_and_wait correlation matching
//   2. router — routes messages to members / TL / all / unknown
//   3. messageQueue — serial FIFO queue processing via router

export function createMessageChannel(deps: MessageChannelDeps): MessageChannel {
  const { pi, memberOpsStates, lastPendingCorrId, memberHandles } = deps;

  // 1. Create responseWaiter first (no dependencies)
  const responseWaiter = createResponseWaiter();

  // 1b. Create the single shared auto-compaction runtime. One instance per
  // channel: the inline path below AND the batch pre-check barrier (phase 3)
  // share the same pending/flush mechanism, so messages queued during a
  // barrier compaction are never orphaned (D2 structural fix).
  const autoCompact = createAutoCompactRuntime(memberOpsStates);

  // 1c. Create the single shared message coalescer (S1, 阶段 2). One instance
  // per channel: createSendToMember registers the flush dispatcher on it and
  // the member event handlers (agent_end batch boundary / compaction_end
  // defensive flush / process-exit drain) operate on the SAME buckets.
  // getCoalescing is wired as the per-flush limits resolver (复审建议 1:
  // configured non-default limits take effect at every flush point).
  const coalescer = createMessageCoalescer(deps.getCoalescing);

  // 1d. Create the TL wait gate (S3): member→TL messages buffer here while a
  // team_send_and_wait wait is in flight; the wait drains + steer-delivers
  // them at all-idle gate open (see tl-wait-gate.ts for the delivery timing).
  const tlWaitGate = createTlWaitGate();

  // P2（peer-messaging 强制层，D1 裁决）：sender 回执计数。回执是唯一让成员
  // LLM 立即改道的闭环（否则成员工具恒返回「[消息已发送]」假成功，旧成员在
  // 窗口期会基于「对方已收到」继续推理）；per-from 计数上限去抖（丙路径）
  // 防循环重试刷屏。与 channel 同生命周期，超过成员数上限整体清零（参照
  // recentlyProcessedMessages 的剪枝姿态，数量级防御）。
  const PEER_ACK_LIMIT_PER_MEMBER = 3;
  const PEER_ACK_COUNT_MAX_MEMBERS = 100;
  const peerAckCounts = new Map<string, number>();

  // 2. Create router (callbacks capture responseWaiter + other deps)
  const router = createRouter({
    sendToMember: createSendToMember({
      pi,
      memberOpsStates,
      memberHandles,
      responseWaiter,
      lastPendingCorrId,
      getAutoCompact: deps.getAutoCompact,
      autoCompact,
      coalescer,
      getCoalescing: deps.getCoalescing,
    }),

    sendToTl: (msg: TeamMessage) => {
      // Check if ResponseWaiter has a pending wait for this message
      const corrId = msg.correlationId ?? extractCorrelationId(msg.content);
      if (corrId) {
        const resolved = responseWaiter.resolveIfWaiting(
          corrId, msg.from, msg.content, msg.subject
        );
        if (resolved) {
          lastPendingCorrId.delete(msg.from);
          return; // consumed by waiter, skip sendMessage
        }
      }
      // S3（等待期缓冲，阶段 3 v2）：team_send_and_wait 等待期间到达的非回复消息
      // 改入 tlWaitGate 缓冲——门控（全员空闲，决策 #38）打开后由
      // waitWithAllIdleCheck drain 并**并入工具结果**一并返回（[from message]
      // 段落，位于回复之后）。pi 的 nextTurn 队列无公开 drain API，故缓冲
      // 决策必须在消息到达时做出。无等待在飞时保持 S2 nextTurn 语义不变。
      if (tlWaitGate.isWaitActive()) {
        tlWaitGate.buffer(msg);
        return;
      }
      pi.sendMessage(
        {
          customType: "team-message",
          content: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
          display: true,
          details: { msg },
        },
        // S2 (member→TL 消息合并，阶段 1): deliverAs:"nextTurn" 让成员消息进
        // pi 的 _pendingNextTurnMessages，下一次任意回合开始时与用户消息统一
        // 注入 context——不打断 TL 正在进行的回合（零 steer）、idle 时也不触发
        // 新回合。版本验证：peerDep 0.83.0 dist/core/agent-session.js
        // sendCustomMessage 的 options.deliverAs === "nextTurn" 分支直接 push
        // （1075-1077 行）；prompt() 构建 messages 时注入全部 pending 消息并清空
        // （876-880 行）；扩展 API SendMessageHandler 类型含 "nextTurn"
        // （dist/core/extensions/types.d.ts）。resolveIfWaiting 前置分支不变：
        // wait 回复被消费后根本到不了这里（零影响）。
        { deliverAs: "nextTurn" }
      );
    },

    memberNames: [],
    isPeerMessagingAllowed: deps.getPeerMessagingAllowed,
    onUnknownTarget: (from, to) => {
      pi.sendMessage({
        customType: "team-route",
        content: `消息目标 "${to}" 不存在（来自 ${from}）。有效目标：tl、all、团队成员名称。`,
        display: true,
      });
    },
    onPeerBlocked: (from, to) => {
      // TL 通知（即时 team-route，onUnknownTarget 同构）。MVP 恒发（频繁互发
      // 禁用团队会刷屏为已知噪音，方案已记录；输入端由回执上限收口）。
      pi.sendMessage({
        customType: "team-route",
        content: `⚠️ 成员 ${from}→${to} 的消息被拦截（该团队已禁用成员互发）；成员需改为回复 TL 或经 stop_member+start_member 刷新策略`,
        display: true,
      });
      // sender 回执（D1）：拒绝闭环。crashed/stopped 的成员不再派发（进程已
      // 死，通知无法处理；TL 通知已覆盖可观测性）。
      const state = memberOpsStates.get(from) ?? "idle";
      if (state === "crashed" || state === "stopped") return;
      // per-from 上限：达上限后静默（仅 TL 通知），防成员循环重试刷屏。
      const count = peerAckCounts.get(from) ?? 0;
      if (count >= PEER_ACK_LIMIT_PER_MEMBER) return;
      peerAckCounts.set(from, count + 1);
      if (peerAckCounts.size > PEER_ACK_COUNT_MAX_MEMBERS) {
        peerAckCounts.clear();
      }
      // 回执不计 corrId、不进 messageQueue（非互发性质的 TL→member 派发）
      // ——直接走派发语义（working 标记 + followUp 保序）。不传 coalescer：
      // 回执失败通知不应误带「合并包含 N 条」注记（takeMergedCount 是他人
      // 消息的遗留状态）。
      dispatchPromptTextToMember(
        { pi, memberOpsStates, memberHandles, lastPendingCorrId, responseWaiter },
        from,
        `[系统通知（消息通道）] 你发送给 ${to} 的消息未送达——该团队已禁用成员互发（只能回复 TL）。后续请直接回复 TL 说明协作需求。`
      );
    },
  });

  // 3. Create message queue (handler captures router)
  const messageQueue = createMessageQueue(
    async (msg: TeamMessage) => {
      // UI-only routing notification for messages from TL
      if (msg.from === "tl") {
        deps.onRouteNotification?.(msg.to);
      }
      router.route(msg);
    },
    {
      onHandlerError: (msg, err) => {
        pi.sendMessage({
          customType: "team-route",
          content: `处理消息（${msg.id}）时出错：${err.message}`,
          display: true,
        });
      },
    }
  );

  return { router, messageQueue, responseWaiter, autoCompact, coalescer, tlWaitGate };
}
