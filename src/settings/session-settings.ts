import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TeamSettings } from "./settings";

/**
 * 临时设置（per-session settings）数据层。
 *
 * 形态：进程内单值 overlay（当前 pi 会话的临时设置）+ 团队会话锚定的快照文件
 * （resume 恢复通道）。见 AGENTS.md 决策 #40 与最终方案（rev2）。
 *
 * 核心不变量：
 *  1. 内存 overlay 是唯一权威；快照只是 /team resume 的恢复通道，从不反向污染全局。
 *  2. 快照只在团队会话活跃期间写入（写盘接线在消费点层，见阶段 3）。
 *  3. /team resume 仅在内存 overlay 为空时从目标会话目录加载。
 *  4. 清除动作（clear/clearAll）同时清除内存与绑定快照（防「清了又复活」）。
 *  5. 失效机制：session_start 时 reconcile（派生信号，事件丢失免疫）+ session_shutdown
 *     清内存补充通道（双保险）。两者都只清内存、不清快照（快照保留供 resume）。
 */

const SNAPSHOT_FILE = "session-settings.yaml";

/**
 * 深字段级补丁类型：overlay 顶层与内部字段均可部分提供（undefined 字段 = 不覆盖）。
 * merge 语义要求两层的字段级补丁，故不能用浅 Partial<TeamSettings>。
 * 注意：条件分支必须用 `object | undefined` 判型——可选项的 T[K] 含 undefined，
 * 直接 `T[K] extends object` 对可选项恒为 false（非分发求值），深化会失效。
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | undefined ? DeepPartial<NonNullable<T[K]>> : T[K];
};

/** 单值 overlay：深 Partial 字段级补丁。 */
let sessionSettings: DeepPartial<TeamSettings> = {};
/** 最近一次 reconcile / 快照恢复时记录的 pi sessionId；session_start 对比变化则清除。 */
let sessionSettingsSessionId: string | null = null;
/** 最近一次快照写入的团队会话目录（binding）。null = 未绑定（清除动作不触碰磁盘）。 */
let bindingSessionDir: string | null = null;

/** 快照文件只接受这 5 个 TeamSettings 顶层键（load 时过滤未知键）。 */
const SESSION_SETTING_KEYS: readonly (keyof TeamSettings)[] = [
  "memberModel",
  "autoCompact",
  "waitTimeoutMinutes",
  "memberThinkingLevel",
  "messageCoalescing",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 快照文件路径：<sessionDir>/session-settings.yaml（与 manifest 同目录，/team delete 时随目录删除）。 */
export function getSessionSettingsSnapshotPath(sessionDir: string): string {
  return join(sessionDir, SNAPSHOT_FILE);
}

/** 返回当前 overlay 的深拷贝（外部修改不影响内部状态）。 */
export function getSessionSettings(): Readonly<DeepPartial<TeamSettings>> {
  return structuredClone(sessionSettings);
}

/** 写入一个临时设置字段（深拷贝入内存）。undefined 视为无效调用（no-op，符合 undefined=不覆盖约定）。 */
export function setSessionSetting<K extends keyof TeamSettings>(
  key: K,
  value: DeepPartial<TeamSettings[K]>
): void {
  if (value === undefined) {
    return;
  }
  sessionSettings[key] = structuredClone(value) as DeepPartial<TeamSettings>[K];
}

/**
 * 恢复单个字段为全局值（删内存键）；已绑定快照时同步移除快照中的该字段，
 * 若 overlay 已空则删除整个快照文件（不变量 4：防「清了又复活」）。
 */
export function clearSessionSetting(key: keyof TeamSettings): void {
  delete sessionSettings[key];
  if (bindingSessionDir) {
    if (Object.keys(sessionSettings).length === 0) {
      clearBindingSnapshot();
    } else {
      saveSessionSettingsSnapshot(bindingSessionDir);
    }
  }
}

/** 一键回滚：清空内存 overlay + 删除绑定快照（S7：clear 后 resume 不复活）。 */
export function clearAllSessionSettings(): void {
  sessionSettings = {};
  clearBindingSnapshot();
}

/**
 * 只清内存、不清快照（session_shutdown 补充通道用）。
 * 注意：不得与 clearAllSessionSettings 混用——shutdown 后快照必须保留供 /team resume 恢复。
 */
export function clearSessionSettingsMemory(): void {
  sessionSettings = {};
}

/**
 * 生命周期守卫（主失效通道）：session_start 时传入当前 pi sessionId。
 * 与记录值不同且 overlay 非空 → 清空内存 overlay（不删快照），返回 true。
 * 空串（会话标识不可用）→ no-op fail-open（不清除、不改写记录）。
 */
export function reconcileSessionSettings(sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  const prev = sessionSettingsSessionId;
  sessionSettingsSessionId = sessionId;
  if (prev === sessionId) {
    return false;
  }
  if (Object.keys(sessionSettings).length === 0) {
    return false;
  }
  sessionSettings = {};
  return true;
}

/**
 * 纯函数：global 打底、overlay 深字段级补丁（两层：顶层字段 + 内部字段逐一覆盖）。
 * overlay 中 undefined 视为不覆盖；全部 structuredClone，杜绝引用共享，不改动输入。
 */
export function resolveEffectiveSettings(
  global: TeamSettings,
  overlay: DeepPartial<TeamSettings>
): TeamSettings {
  const result = structuredClone(global) as unknown as Record<string, unknown>;
  for (const key of Object.keys(overlay) as (keyof TeamSettings)[]) {
    const patch = overlay[key];
    if (patch === undefined) {
      continue;
    }
    if (isPlainObject(patch)) {
      // 内部字段级合并：过滤 undefined 字段（= 不覆盖），其余逐字段覆盖
      const cleanPatch = structuredClone(
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      ) as Record<string, unknown>;
      const base = result[key];
      result[key] = {
        ...(isPlainObject(base) ? structuredClone(base) : {}),
        ...cleanPatch,
      };
    } else {
      result[key] = structuredClone(patch);
    }
  }
  return result as unknown as TeamSettings;
}

/**
 * 团队活跃期 overlay 变更后调用：把当前 overlay 原子写盘到 <sessionDir>/session-settings.yaml
 * （tmp+rename，无 .tmp 残留），成功后更新 binding。fs 失败 fail-open（内存照常生效，
 * 仅 resume 恢复能力降级），返回是否写入成功。
 */
export function saveSessionSettingsSnapshot(sessionDir: string): boolean {
  try {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    const filePath = getSessionSettingsSnapshotPath(sessionDir);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, stringifyYaml(sessionSettings, { lineWidth: 120 }), "utf-8");
    renameSync(tmpPath, filePath);
    bindingSessionDir = sessionDir;
    return true;
  } catch (err) {
    console.warn(
      `[top-notch-team] Failed to write session settings snapshot: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/**
 * /team resume 时调用（startResumedMember 之前）：内存 overlay 为空才从目标会话目录
 * 读快照并加载（本会话显式设置优先，S5）。加载成功后：
 *  - sessionSettingsSessionId 更新为当前 pi sessionId（防 reload 误清）；
 *  - binding 绑定到该会话目录（后续清除动作写回同一快照，防「清了又复活」）。
 * 文件缺失/解析失败 fail-open（忽略不报错），返回是否加载。
 */
export function loadSessionSettingsSnapshot(sessionDir: string, currentSessionId: string): boolean {
  if (Object.keys(sessionSettings).length > 0) {
    return false;
  }
  const filePath = getSessionSettingsSnapshotPath(sessionDir);
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const data = parseYaml(readFileSync(filePath, "utf-8"));
    if (!isPlainObject(data)) {
      return false;
    }
    const loaded: Record<string, unknown> = {};
    for (const key of SESSION_SETTING_KEYS) {
      const value = data[key];
      if (value !== undefined) {
        loaded[key] = value;
      }
    }
    sessionSettings = loaded as unknown as DeepPartial<TeamSettings>;
    if (currentSessionId) {
      sessionSettingsSessionId = currentSessionId;
    }
    bindingSessionDir = sessionDir;
    return true;
  } catch {
    return false;
  }
}

/** 清除绑定快照：删除文件 + binding 置空。clear/clearAll 联动（不变量 4）。 */
function clearBindingSnapshot(): void {
  if (bindingSessionDir) {
    try {
      const filePath = getSessionSettingsSnapshotPath(bindingSessionDir);
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    } catch {
      // 删除失败 fail-open：残留快照只影响 resume 恢复，不阻塞清除
    }
    bindingSessionDir = null;
  }
}

/**
 * 测试专用：完全重置模块状态（overlay / recorded sessionId / binding），不触碰磁盘。
 * 生产路径用 clearAllSessionSettings / clearSessionSettingsMemory / reconcile 管理状态。
 */
export function resetSessionSettingsState(): void {
  sessionSettings = {};
  sessionSettingsSessionId = null;
  bindingSessionDir = null;
}
