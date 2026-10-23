export type OverviewActionKind =
  | "thinking" | "output" | "read" | "modify" | "tool"
  | "complete" | "compacting" | "crashed" | "stopped";

export interface OverviewAction {
  readonly id: number;
  readonly kind: OverviewActionKind;
  readonly status: "active" | "done" | "error";
  readonly toolName?: string;
}

export interface MemberOverviewStore {
  onEvent(name: string, event: any): boolean;
  getRecentActions(name: string): readonly OverviewAction[];
  /** Confirmed member-side compaction, independent of dispatch reservations. */
  isCompacting(name: string): boolean;
  syncMembers(names: readonly string[]): void;
  clear(): void;
  /** Only confirmed physical compaction; never the dispatch reservation. */
  markCompacting(name: string, active: boolean): boolean;
}

const CAPACITY = 64;
const MAX_TOOL_ID = 256;
const MAX_TOOL_NAME = 80;
const EMPTY: readonly OverviewAction[] = Object.freeze([]);
type BlockKind = "thinking" | "output" | "tool";
interface Entry {
  action: OverviewAction;
  live: boolean;
  blockKey?: string;
  blockKind?: BlockKind;
  blockIndex?: number;
  toolId?: string;
}
interface Member {
  ring: (Entry | undefined)[];
  head: number;
  count: number;
  blocks: Map<string, Entry>;
  tools: Map<string, Entry>;
  // Fixed-size watermarks prevent an evicted block's late delta resurrecting it.
  evicted: Record<BlockKind, number>;
  ended: boolean;
  messageClosed: boolean;
  dead: boolean;
  compacting: boolean;
  compactionEnded: boolean;
  compactionTurn: boolean;
  compaction?: Entry;
}

function toolId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_ID ? value : undefined;
}
function shortToolName(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TOOL_NAME) : undefined;
}
function classify(name: unknown): OverviewActionKind {
  return name === "read" ? "read" : name === "write" || name === "edit" ? "modify" : "tool";
}
function failed(event: any): boolean {
  return event.isError === true || event.success === false || event.aborted === true ||
    Boolean(event.error) || Boolean(event.errorMessage);
}

/** Team-session display storage. No RPC, timers, control-plane writes, or raw payload retention. */
export function createMemberOverviewStore(): MemberOverviewStore {
  const members = new Map<string, Member>();
  let nextId = 1;

  function member(name: string): Member {
    let m = members.get(name);
    if (!m) {
      m = {
        ring: new Array(CAPACITY), head: 0, count: 0,
        blocks: new Map(), tools: new Map(), evicted: { thinking: -1, output: -1, tool: -1 },
        ended: false, messageClosed: false, dead: false,
        compacting: false, compactionEnded: false, compactionTurn: false,
      };
      members.set(name, m);
    }
    return m;
  }
  function entries(m: Member): Entry[] {
    const out: Entry[] = [];
    for (let i = 0; i < m.count; i++) out.push(m.ring[(m.head + i) % CAPACITY]!);
    return out;
  }
  function append(m: Member, kind: OverviewActionKind, status: OverviewAction["status"], name?: string): Entry {
    const entry: Entry = {
      action: Object.freeze({ id: nextId++, kind, status, ...(name ? { toolName: name } : {}) }),
      live: true,
    };
    if (m.count === CAPACITY) {
      const old = m.ring[m.head]!;
      old.live = false;
      if (old.blockKey && m.blocks.get(old.blockKey) === old) {
        m.blocks.delete(old.blockKey);
        m.evicted[old.blockKind!] = Math.max(m.evicted[old.blockKind!], old.blockIndex!);
      }
      if (old.toolId && m.tools.get(old.toolId) === old) m.tools.delete(old.toolId);
      m.ring[m.head] = entry;
      m.head = (m.head + 1) % CAPACITY;
    } else {
      m.ring[(m.head + m.count) % CAPACITY] = entry;
      m.count++;
    }
    return entry;
  }
  function update(entry: Entry | undefined, patch: Partial<Omit<OverviewAction, "id">>): boolean {
    if (!entry?.live) return false;
    const next = { ...entry.action, ...patch };
    if (next.kind === entry.action.kind && next.status === entry.action.status && next.toolName === entry.action.toolName) return false;
    entry.action = Object.freeze(next);
    return true;
  }
  function close(m: Member, status: "done" | "error", includeCompaction = false): boolean {
    let changed = false;
    for (const entry of entries(m)) {
      if (entry.action.status === "active" && (includeCompaction || entry.action.kind !== "compacting"))
        changed = update(entry, { status }) || changed;
    }
    return changed;
  }
  function resetMessage(m: Member): void {
    m.blocks.clear();
    m.evicted = { thinking: -1, output: -1, tool: -1 };
    m.messageClosed = false;
  }
  function resetProcess(m: Member): void {
    resetMessage(m);
    m.tools.clear();
    m.dead = false;
    m.ended = false;
  }
  function compaction(m: Member, active: boolean, error = false, confirmedEnd = false): boolean {
    if (active) {
      if (m.compacting || m.dead) return false;
      m.compacting = true;
      m.compactionEnded = false;
      m.compaction = append(m, "compacting", "active");
      return true;
    }
    if (!m.compacting) {
      if (!confirmedEnd || m.compactionEnded || m.dead) return false;
      m.compactionEnded = true;
      append(m, "compacting", error ? "error" : "done");
      return true;
    }
    m.compacting = false;
    m.compactionEnded = true;
    update(m.compaction, { status: error ? "error" : "done" });
    m.compaction = undefined;
    // The live compaction flag changed even if its old trail entry was evicted.
    return true;
  }
  function execution(m: Member, event: any, end: boolean): boolean {
    const id = toolId(event.toolCallId);
    const existing = id ? m.tools.get(id) : undefined;
    if (end) return update(existing, { status: failed(event) ? "error" : existing?.action.status === "error" ? "error" : "done" });
    const name = shortToolName(event.toolName);
    if (existing) return update(existing, { kind: classify(event.toolName), ...(name ? { toolName: name } : {}) });
    const entry = append(m, classify(event.toolName), "active", name);
    if (id) {
      entry.toolId = id;
      m.tools.set(id, entry);
    }
    return true;
  }

  return {
    onEvent(name, event) {
      if (!event || typeof event !== "object" || typeof event.type !== "string") return false;
      const type = event.type;
      // get_state is member-side evidence. get_session_stats is not: its query
      // runs while dispatch temporarily reserves the logical compacting state.
      if (type === "response" && event.command === "get_state" && event.success !== false &&
        typeof event.data?.isCompacting === "boolean") {
        return compaction(member(name), event.data.isCompacting);
      }
      // Avoid allocating member state for unrecognized or malformed events.
      if (!["agent_start", "agent_end", "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_end", "process_exit", "process_error",
        "process_start", "process_started", "compaction_start", "compaction_end",
        "auto_compaction_start", "auto_compaction_end"].includes(type)) return false;
      const m = member(name);
      if (type === "compaction_start" || type === "auto_compaction_start") return compaction(m, true);
      if (type === "compaction_end" || type === "auto_compaction_end") {
        const error = failed(event);
        // An end notification alone does not prove compaction ran. pi can emit
        // failure-only ends without a start; only a committed summary repairs a
        // missed start. Observed starts/operational edges still close normally.
        const confirmedEnd = !error && typeof event.result?.summary === "string";
        return compaction(m, false, error, confirmedEnd);
      }
      if (type === "process_exit" || type === "process_error") {
        if (m.dead) return false;
        const normal = type === "process_exit" && [0, 143, null].includes(event.exitCode);
        close(m, normal ? "done" : "error", true);
        m.blocks.clear();
        m.tools.clear();
        m.compacting = false;
        m.compaction = undefined;
        m.compactionEnded = false;
        m.compactionTurn = false;
        m.dead = m.ended = m.messageClosed = true;
        append(m, normal ? "stopped" : "crashed", normal ? "done" : "error");
        return true;
      }
      if (type === "process_start" || type === "process_started") {
        const changed = close(m, "done", true);
        resetProcess(m);
        m.compacting = m.compactionEnded = m.compactionTurn = false;
        m.compaction = undefined;
        return changed;
      }
      if (type === "agent_start") {
        const changed = close(m, "done");
        resetProcess(m);
        m.compactionTurn = m.compacting;
        return changed;
      }
      if (m.dead || m.ended) return false;
      if (type === "agent_end") {
        m.ended = m.messageClosed = true;
        const changed = close(m, "done");
        if (m.compacting || m.compactionTurn) return changed;
        append(m, "complete", "done");
        return true;
      }
      if (type === "tool_execution_start" || type === "tool_execution_end") return execution(m, event, type === "tool_execution_end");
      if (type === "message_start") {
        if (event.message?.role && event.message.role !== "assistant") return false;
        const changed = closeMessage(m);
        resetMessage(m);
        return changed;
      }
      if (type === "message_end") {
        if (event.message?.role === "toolResult") return execution(m, event.message, true);
        if (event.message?.role && event.message.role !== "assistant") return false;
        m.messageClosed = true;
        return closeMessage(m);
      }
      if (type !== "message_update" || m.messageClosed) return false;
      const d = event.assistantMessageEvent;
      const index = d?.contentIndex;
      if (!Number.isSafeInteger(index) || index < 0) return false;
      if (d.type === "toolcall_start" || d.type === "toolcall_delta" || d.type === "toolcall_end") {
        // RPC strips partial on streaming updates. If no ID is observable, wait
        // for toolcall_end/tool_execution_start rather than guessing by position.
        const call = d.toolCall ?? d.partial?.content?.[index];
        const id = toolId(d.toolCallId ?? call?.id);
        const key = `tool:${index}`;
        if (!id || m.tools.has(id) || m.blocks.has(key) || index <= m.evicted.tool) return false;
        const entry = append(m, "tool", "active", shortToolName(call?.name));
        entry.toolId = id;
        entry.blockKey = key;
        entry.blockKind = "tool";
        entry.blockIndex = index;
        m.blocks.set(key, entry);
        m.tools.set(id, entry);
        return true;
      }
      const kind: BlockKind | undefined = typeof d.type === "string" && d.type.startsWith("thinking_") ? "thinking"
        : typeof d.type === "string" && d.type.startsWith("text_") ? "output" : undefined;
      if (!kind || !["start", "delta", "end"].includes(d.type.slice(d.type.lastIndexOf("_") + 1))) return false;
      const key = `${kind}:${index}`;
      const old = m.blocks.get(key);
      if (d.type.endsWith("_end")) return old?.action.status === "active" ? update(old, { status: "done" }) : false;
      if (old || index <= m.evicted[kind]) return false;
      const entry = append(m, kind, "active");
      entry.blockKey = key;
      entry.blockKind = kind;
      entry.blockIndex = index;
      m.blocks.set(key, entry);
      return true;
    },
    getRecentActions(name) {
      const m = members.get(name);
      return m ? Object.freeze(entries(m).map(entry => entry.action)) : EMPTY;
    },
    isCompacting(name) { return members.get(name)?.compacting ?? false; },
    syncMembers(names) {
      const keep = new Set(names);
      for (const name of members.keys()) if (!keep.has(name)) members.delete(name);
    },
    clear() { members.clear(); },
    markCompacting(name, active) { return compaction(member(name), active); },
  };

  function closeMessage(m: Member): boolean {
    let changed = false;
    for (const entry of m.blocks.values())
      if (entry.action.status === "active" && entry.blockKind !== "tool") changed = update(entry, { status: "done" }) || changed;
    return changed;
  }
}
