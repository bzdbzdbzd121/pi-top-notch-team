import type { TeamMessage } from "./types";

export interface RouterConfig {
  /** Function to send a message to a specific member via RPC stdin. */
  sendToMember: (memberName: string, msg: TeamMessage) => void;
  /** Function to send a message to the TL via pi.sendMessage. */
  sendToTl: (msg: TeamMessage) => void;
  /** List of valid member names. */
  memberNames: string[];
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

      if (to === "tl") {
        sendToTl(msg);
      } else if (to === "all") {
        for (const name of memberNames) {
          if (name !== from) {
            sendToMember(name, msg);
          }
        }
      } else if (memberSet.has(to)) {
        sendToMember(to, msg);
      } else {
        console.warn(
          `[team-router] Unknown target "${to}". Valid targets: tl, all, ${memberNames.join(", ")}`
        );
      }
    },
  };
}
