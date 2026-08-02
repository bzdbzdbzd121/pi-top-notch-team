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
import { createSendToMember } from "../channel/event-handler";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";

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
}

export interface MessageChannel {
  router: Router;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
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

  // 2. Create router (callbacks capture responseWaiter + other deps)
  const router = createRouter({
    sendToMember: createSendToMember({
      pi,
      memberOpsStates,
      memberHandles,
      responseWaiter,
      lastPendingCorrId,
      getAutoCompact: deps.getAutoCompact,
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
      pi.sendMessage({
        customType: "team-message",
        content: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
        display: true,
        details: { msg },
      });
    },

    memberNames: [],
    onUnknownTarget: (from, to) => {
      pi.sendMessage({
        customType: "team-route",
        content: `消息目标 "${to}" 不存在（来自 ${from}）。有效目标：tl、all、团队成员名称。`,
        display: true,
      });
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

  return { router, messageQueue, responseWaiter };
}
