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
}

export type TeamMessageHandler = (msg: TeamMessage) => void;
