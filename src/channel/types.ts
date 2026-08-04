/** A message sent through the real-time message channel. */
export interface TeamMessage {
  /** Unique message ID. */
  id: string;
  /** Sender name: "tl" or a member name. */
  from: string;
  /** Target: a member name, "tl", or "all". */
  to: string;
  /** Optional subject line. */
  subject?: string;
  /** Message body. */
  content: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Optional correlation ID for send_and_wait matching. */
  correlationId?: string;
  /**
   * True when the auto-compaction decision for this message was ALREADY made
   * by the batch pre-check barrier (phase 3). The inline dispatch path must
   * then skip its own stats/compact check entirely. This is a correctness
   * mechanism, not an optimization: it is the only signal that prevents a
   * second compaction when usage is STILL over threshold after a compact
   * (E12) and prevents re-compaction after a failed one (at most one
   * compaction per dispatch). Messages without this field (member-to-member,
   * Inspector direct, unbatched TL) behave exactly as before.
   */
  skipAutoCompact?: boolean;
}

export type TeamMessageHandler = (msg: TeamMessage) => void;
