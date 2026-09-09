import type { TeamMessage } from "./types";

export interface RouterConfig {
  /** Function to send a message to a specific member via RPC stdin. */
  sendToMember: (memberName: string, msg: TeamMessage) => void;
  /** Function to send a message to the TL via pi.sendMessage. */
  sendToTl: (msg: TeamMessage) => void;
  /** List of valid member names. */
  memberNames: string[];
  /** Called when a message targets an unknown recipient. */
  onUnknownTarget?: (from: string, to: string) => void;
  /**
   * Peer-messaging policy resolver（P2，per-route 实时查询，与 getCoalescing
   * 同构）——false = 该团队已禁用成员互发。缺省（undefined）= 恒允许（fail-open，
   * 禁令缺失时保持现状可用性；resolver 自身的异常 fail-open 在设置层
   * resolvePeerMessaging 内闭合，路由层不做吞错）。
   */
  isPeerMessagingAllowed?: () => boolean;
  /**
   * Called when a member→member / member→all message is blocked by the
   * peer-messaging policy. 缺省 = 静默丢弃（拦截本身已保证不派发）。
   */
  onPeerBlocked?: (from: string, to: string) => void;
}

export interface Router {
  route(msg: TeamMessage): void;
  /** Update the list of valid member names (called when a team session starts). */
  updateMembers(names: string[]): void;
}

/**
 * Create a message router that determines where to deliver each message.
 */
export function createRouter(config: RouterConfig): Router {
  const sendToMember = config.sendToMember;
  const sendToTl = config.sendToTl;
  const memberNames: string[] = [...config.memberNames];
  const memberSet = new Set(memberNames);

  return {
    updateMembers(names: string[]): void {
      memberNames.length = 0;
      memberNames.push(...names);
      memberSet.clear();
      for (const n of names) {
        memberSet.add(n);
      }
    },

    route(msg: TeamMessage): void {
      const { from, to } = msg;

      // Don't route messages to self
      if (from === to) return;

      // to === "tl" 先行（红线 4）：成员→TL 永不受互发禁令影响——禁用态下
      // 成员只能回复 TL，TL→member 派发与 corr 回复链都依赖这条路径。
      if (to === "tl") {
        sendToTl(msg);
        return;
      }

      // P2：peer-messaging 拦截（方案 L2，D5 判定形态）。位置在 from===to 早退
      // 之后、all/memberSet 分支之前——两个进队口（team_send_message 工具路径与
      // assistant 正文 <team-message> 标签备份路径）都经 messageQueue → route()，
      // 单点拦截天然全覆盖（红线 2）。
      const peerBlocked =
        config.isPeerMessagingAllowed !== undefined &&
        !config.isPeerMessagingAllowed() &&
        memberSet.has(from) && // 发送方是成员：TL 派发（from="tl"）与未知来源天然豁免（红线 1）
        (to === "all" || memberSet.has(to)); // 仅作用于有效互发目标；unknown 目标仍走 onUnknownTarget（红线 5，语义不混写）
      if (peerBlocked) {
        config.onPeerBlocked?.(from, to);
        return; // 不进入下游 coalescer / 压缩 pending / 派发（红线 3：sendToMember 是唯一入桶点）
      }

      if (to === "all") {
        for (const name of memberNames) {
          if (name !== from) {
            sendToMember(name, msg);
          }
        }
      } else if (memberSet.has(to)) {
        sendToMember(to, msg);
      } else {
        config.onUnknownTarget?.(msg.from, msg.to);
      }
    },
  };
}
