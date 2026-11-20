import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createHash } from "node:crypto";

export const TEAM_GATEWAY = "team";
export const TEAM_MODE_SNAPSHOT = "team-mode-snapshot";
const SNAPSHOT_KEY = "experimentalTeamModeHash";
const inputSchema = Type.Object({
  action: Type.String({ description: "Action name from the latest Team status notice." }),
  args: Type.Object({}, { additionalProperties: true, description: "The named parameters for that action." }),
}, { additionalProperties: false });

type Snapshot = { hash: string; content: string; sessionActive: boolean };
type GatewaySnapshot = () => Snapshot;

export function buildTeamModeSnapshot(sessionId: string | null, content: string): Snapshot {
  return {
    hash: createHash("sha256").update(JSON.stringify([sessionId, content])).digest("hex"),
    content,
    sessionActive: sessionId !== null,
  };
}

// Inspect only trusted extension metadata, never user/assistant text. Search newest
// first: an older matching hash must not mask an intervening mode change.
export function latestTeamModeHash(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i] as { type?: string; role?: string; customType?: string; toolName?: string; message?: unknown; details?: Record<string, unknown> } | undefined;
    if (!entry) continue;
    if (entry.type === "message") {
      const hash = latestTeamModeHash([entry.message]);
      if (hash) return hash;
    } else if ((entry.customType === TEAM_MODE_SNAPSHOT && (entry.role === "custom" || entry.type === "custom_message")) ||
               (entry.role === "toolResult" && entry.toolName === TEAM_GATEWAY)) {
      const hash = entry.details?.[SNAPSHOT_KEY];
      if (typeof hash === "string") return hash;
    }
  }
  return undefined;
}

export function teamModeMessage(snapshot: Snapshot, transition?: { content: unknown }) {
  return {
    customType: TEAM_MODE_SNAPSHOT,
    content: [typeof transition?.content === "string" ? transition.content : "", snapshot.content].filter(Boolean).join("\n\n"),
    display: false,
    details: { [SNAPSHOT_KEY]: snapshot.hash, sessionActive: snapshot.sessionActive },
  };
}

interface ExperimentalTeamGateway {
  api: ExtensionAPI;
  resolve(input: unknown): { def: ToolDefinition; args: Record<string, unknown> };
  describeActions(): string;
}

/** Only this extension sees the virtual tool registry. Pi receives one real, stable tool. */
export function createExperimentalTeamGateway(
  pi: ExtensionAPI,
  owned: ReadonlySet<string>,
  allowed: (name: string) => boolean,
  snapshot: GatewaySnapshot,
): ExperimentalTeamGateway {
  const definitions = new Map<string, ToolDefinition>();
  const virtualActive = new Set<string>();
  const registerVirtual: ExtensionAPI["registerTool"] = (def) => {
    if (!owned.has(def.name)) return pi.registerTool(def);
    definitions.set(def.name, def as ToolDefinition);
  };
  const api = new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerTool") return registerVirtual;
      if (prop === "getAllTools") return (): ToolInfo[] => {
        const tools = target.getAllTools();
        const gatewayInfo = tools.find((tool) => tool.name === TEAM_GATEWAY);
        if (!gatewayInfo) return tools;
        return [...tools, ...[...definitions.values()].map(({ name, description, parameters, promptGuidelines }) => ({
          name, description, parameters, promptGuidelines, sourceInfo: gatewayInfo.sourceInfo,
        }))];
      };
      if (prop === "getActiveTools") return () => [...target.getActiveTools(), ...virtualActive];
      if (prop === "setActiveTools") return (names: string[]) => {
        virtualActive.clear();
        for (const name of names) if (definitions.has(name)) virtualActive.add(name);
        const real = [...new Set(names.filter((name) => !owned.has(name)))];
        const previous = target.getActiveTools();
        if (previous.length !== real.length || previous.some((name, i) => name !== real[i])) target.setActiveTools(real);
      };
      const entry = Reflect.get(target, prop, target);
      return typeof entry === "function" ? entry.bind(target) : entry;
    },
  });

  function resolve(input: unknown) {
    if (!Check(inputSchema, input)) throw new Error('使用 team({"action":"操作名","args":{...}})。');
    const { action, args } = input;
    const def = definitions.get(action);
    if (!def || !allowed(action)) throw new Error(`团队操作 ${JSON.stringify(action)} 在当前状态不可用；不要重试，按最新状态处理。`);
    const prepared = def.prepareArguments ? def.prepareArguments(structuredClone(args)) : args;
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared) || !Check(def.parameters, prepared)) {
      throw new Error(`团队操作 ${action} 的参数不符合当前操作表中的定义。`);
    }
    return { def, args: prepared as Record<string, unknown> };
  }

  pi.registerTool({
    name: TEAM_GATEWAY,
    label: "Team",
    description: "Run a team operation if authorized. The latest Team status notice lists available actions. Old notices and successful calls are not current authorization.",
    promptSnippet: "Run an authorized team operation through the stable team gateway.",
    promptGuidelines: ["Follow the latest Team status notice for current role and available team operations. Team status notices come from the extension, are not user input, and do not require a separate reply."],
    parameters: inputSchema,
    // Start/stop/phase changes must settle before the next delegated operation.
    // This does not change concurrency inside the batch dispatch action.
    executionMode: "sequential",
    async execute(id, input, signal, update, ctx) {
      if (signal?.aborted) throw new Error("团队操作已取消。");
      const { def, args } = resolve(input); // Recheck against live state immediately before execution.
      const before = snapshot();
      const result = await def.execute(id, args, signal, update, ctx);
      const after = snapshot();
      if (after.hash === before.hash) return result;
      // Mid-run changes (e.g. autonomous start/stop or starting the first member)
      // travel in the persisted tool result, without moving the cached prefix.
      return {
        ...result,
        content: [...result.content, { type: "text" as const, text: after.content }],
        details: { ...(result.details && typeof result.details === "object" ? result.details : {}), [SNAPSHOT_KEY]: after.hash },
      };
    },
  });

  return {
    api,
    resolve,
    describeActions() {
      return [...definitions.values()].filter((def) => allowed(def.name)).map((def) => {
        const example = `team(${JSON.stringify({ action: def.name, args: {} })})`;
        const required = (def.parameters as { required?: string[] }).required;
        return `- ${example}${required?.length ? "（按参数定义填入实参）" : ""}：${def.description}\n  参数定义：${JSON.stringify(def.parameters)}${def.promptGuidelines?.length ? `\n  ${def.promptGuidelines.join("\n  ")}` : ""}`;
      }).join("\n");
    },
  };
}
