import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isMemberThinkingLevel } from "./resolve-thinking";
import {
  loadSettings,
  type AutoCompactSetting,
  type MemberModelSetting,
  type MessageCoalescingSetting,
  type TeamSettings,
} from "./settings";

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
 *     binding 与团队会话生命周期联动（setActiveSessionDir）：start → binding=dir
 *     （本会话 clear 只作用于本会话快照，S8）；stop → binding=null（clear 纯内存，
 *     快照冻结为最近活跃期状态，S6）。S7「clear 不复活」只约束活跃期 clear。
 *  5. 失效机制：session_start 时 reconcile（派生信号，事件丢失免疫）+ session_shutdown
 *     清内存补充通道（双保险）。两者都只清内存、不清快照（快照保留供 resume）；
 *     但 reconcile 在会话变化时同时清 binding（仅内存）——跨会话残留的 binding 会让
 *     新会话的无关清除动作误删旧会话快照（审查 #1）。
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
/**
 * 当前活跃团队会话的会话目录（阶段 3 注入，index.ts 在 onSessionStart/onSessionEnd 维护）。
 * 不变量 2：快照只在团队会话活跃期间写入——set 仅在 activeSessionDir 非空时写盘；
 * stop 后（置 null）变更纯内存（S6），快照保持「最近活跃期状态」。
 */
let activeSessionDir: string | null = null;

/**
 * 快照恢复标记：loadSessionSettingsSnapshot 成功应用数据时置位（阶段 5 可观测性——
 * start_member 结果区分「（临时）」与「（恢复自团队会话）」来源）。随 overlay 的
 * 清空动作（clearAll/clearMemory/reconcile 会话变化）复位；普通 set/clear 不复位
 * （恢复值仍与后续编辑共存，来源标注保持准确）。
 */
let snapshotRestored = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 快照文件路径：<sessionDir>/session-settings.yaml（与 manifest 同目录，/team delete 时随目录删除）。 */
export function getSessionSettingsSnapshotPath(sessionDir: string): string {
  return join(sessionDir, SNAPSHOT_FILE);
}

/**
 * 注入/清除当前活跃团队会话目录（阶段 3 写盘钩子）。
 * 团队会话启动（/team start、/team dynamic、/team resume）→ 传入会话目录；
 * 会话结束（/team stop、stop_team_session、pi 会话切换 teardown）→ 传入 null。
 * 仅影响 set 的即时写盘；clear/clearAll 仍走 binding 语义（不变量 4）。
 *
 * binding 与团队会话生命周期联动（审查 #1）：start → binding=dir（本会话的
 * clear/clearAll 只作用于本会话快照，S8）；stop → binding=null（clear 纯内存，
 * 快照冻结为最近活跃期状态，S6）。S7「clear 不复活」只约束活跃期 clear。
 */
export function setActiveSessionDir(sessionDir: string | null): void {
  activeSessionDir = sessionDir;
  bindingSessionDir = sessionDir;
}

/** 返回当前 overlay 的深拷贝（外部修改不影响内部状态）。 */
export function getSessionSettings(): Readonly<DeepPartial<TeamSettings>> {
  return structuredClone(sessionSettings);
}

/**
 * 写入一个临时设置字段（深拷贝入内存）。undefined 视为无效调用（no-op，符合 undefined=不覆盖约定）。
 * 团队会话活跃期间（activeSessionDir 非空）即时写快照（不变量 2，resume 恢复通道）。
 */
export function setSessionSetting<K extends keyof TeamSettings>(
  key: K,
  value: DeepPartial<TeamSettings[K]>
): void {
  if (value === undefined) {
    return;
  }
  sessionSettings[key] = structuredClone(value) as DeepPartial<TeamSettings>[K];
  if (activeSessionDir) {
    saveSessionSettingsSnapshot(activeSessionDir);
  }
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
  snapshotRestored = false;
  clearBindingSnapshot();
}

/**
 * 只清内存、不清快照（session_shutdown 补充通道用）。
 * 注意：不得与 clearAllSessionSettings 混用——shutdown 后快照必须保留供 /team resume 恢复。
 */
export function clearSessionSettingsMemory(): void {
  sessionSettings = {};
  snapshotRestored = false;
}

/**
 * 生命周期守卫（主失效通道）：session_start 时传入当前 pi sessionId。
 * 与记录值不同且 overlay 非空 → 清空内存 overlay（不删快照），返回 true。
 * 会话变化时**无论 overlay 是否为空**都把 bindingSessionDir 置 null（仅内存、不碰磁盘）
 * ——防止跨会话残留导致新会话的无关清除动作误删旧会话快照（审查 #1）。
 * 空串（会话标识不可用）→ no-op fail-open（不清除、不改写记录、不清 binding）。
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
  bindingSessionDir = null;
  // 防御层：跨 pi 会话残留的活跃目录一并清除（正常路径由 onSessionEnd 置空）
  activeSessionDir = null;
  if (Object.keys(sessionSettings).length === 0) {
    return false;
  }
  sessionSettings = {};
  snapshotRestored = false;
  return true;
}

/**
 * 合并层唯一入口（阶段 5 收敛）：磁盘全局 + 内存 overlay 深合并。
 * 所有全局设置读取点必须经此函数或 index.ts 的 getEffectiveSettings（即本函数的
 * 薄封装）——静态扫描守卫（src/static-scan.test.ts）强制除白名单模块外无裸
 * loadSettings 调用，防止新增消费点绕过合并层导致临时设置静默失效（R4）。
 */
export function loadEffectiveSettings(rootDir: string): TeamSettings {
  return resolveEffectiveSettings(loadSettings(rootDir), sessionSettings);
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

/** 整数区间校验（含边界）。 */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** 正整数校验。 */
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 快照内容字段级校验（镜像全局 loadSettings 的逐字段严格姿态）：
 * 只保留已知顶层键中语义合法的字段，非法字段/非法值整体丢弃（fail-open 不变）。
 * 未知键与 null 不进入 overlay（overlay 类型无 null 魔法；undefined = 不覆盖）。
 */
function sanitizeSnapshotData(data: Record<string, unknown>): DeepPartial<TeamSettings> {
  const out: DeepPartial<TeamSettings> = {};

  const mm = data.memberModel;
  if (isPlainObject(mm)) {
    const m: DeepPartial<MemberModelSetting> = {};
    if (mm.mode === "follow" || mm.mode === "fixed") {
      m.mode = mm.mode;
    }
    if (typeof mm.model === "string" && mm.model.length > 0) {
      m.model = mm.model;
    }
    if (Object.keys(m).length > 0) {
      out.memberModel = m;
    }
  }

  const ac = data.autoCompact;
  if (isPlainObject(ac)) {
    const a: DeepPartial<AutoCompactSetting> = {};
    if (typeof ac.enabled === "boolean") {
      a.enabled = ac.enabled;
    }
    if (isIntInRange(ac.thresholdPercent, 1, 100)) {
      a.thresholdPercent = ac.thresholdPercent;
    }
    if (isPositiveInt(ac.thresholdTokens)) {
      a.thresholdTokens = ac.thresholdTokens;
    }
    if (isPositiveInt(ac.timeoutMinutes)) {
      a.timeoutMinutes = ac.timeoutMinutes;
    }
    if (Object.keys(a).length > 0) {
      out.autoCompact = a;
    }
  }

  // waitTimeoutMinutes：0 = 不限（合法值），负值/非整数丢弃
  if (isIntInRange(data.waitTimeoutMinutes, 0, Number.MAX_SAFE_INTEGER)) {
    out.waitTimeoutMinutes = data.waitTimeoutMinutes;
  }

  const mtl = data.memberThinkingLevel;
  if (isMemberThinkingLevel(mtl)) {
    out.memberThinkingLevel = mtl;
  }

  const mc = data.messageCoalescing;
  if (isPlainObject(mc)) {
    const c: DeepPartial<MessageCoalescingSetting> = {};
    if (typeof mc.enabled === "boolean") {
      c.enabled = mc.enabled;
    }
    if (isPositiveInt(mc.maxBatchSize)) {
      c.maxBatchSize = mc.maxBatchSize;
    }
    if (isPositiveInt(mc.maxBatchChars)) {
      c.maxBatchChars = mc.maxBatchChars;
    }
    if (Object.keys(c).length > 0) {
      out.messageCoalescing = c;
    }
  }

  return out;
}

/**
 * 团队活跃期 overlay 变更后调用：把当前 overlay 原子写盘到 <sessionDir>/session-settings.yaml
 * （tmp+rename），成功后更新 binding。fs 失败 fail-open（内存照常生效，仅 resume 恢复能力
 * 降级），返回是否写入成功。失败时清理 .tmp 残留（审查 #3）。
 */
export function saveSessionSettingsSnapshot(sessionDir: string): boolean {
  const filePath = getSessionSettingsSnapshotPath(sessionDir);
  const tmpPath = `${filePath}.tmp`;
  try {
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    writeFileSync(tmpPath, stringifyYaml(sessionSettings, { lineWidth: 120 }), "utf-8");
    renameSync(tmpPath, filePath);
    bindingSessionDir = sessionDir;
    return true;
  } catch (err) {
    try {
      // rename 失败时清理已写入的 .tmp，避免残留文件堆积
      rmSync(tmpPath, { force: true });
    } catch {
      // 清理失败 fail-open
    }
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
 * 内容经字段级校验（sanitizeSnapshotData，非法字段丢弃）；文件缺失/解析失败/
 * 无有效字段均 fail-open（忽略不报错），返回是否加载。
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
    const loaded = sanitizeSnapshotData(data);
    if (Object.keys(loaded).length === 0) {
      return false;
    }
    sessionSettings = loaded;
    snapshotRestored = true;
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

/** 快照恢复标记读取（阶段 5 可观测性：start_member 来源附注用）。 */
export function isSnapshotRestored(): boolean {
  return snapshotRestored;
}

/**
 * 测试专用：完全重置模块状态（overlay / recorded sessionId / binding / active dir /
 * snapshotRestored），不触碰磁盘。生产路径用 clearAllSessionSettings /
 * clearSessionSettingsMemory / reconcile / setActiveSessionDir 管理状态。
 */
export function resetSessionSettingsState(): void {
  sessionSettings = {};
  sessionSettingsSessionId = null;
  bindingSessionDir = null;
  activeSessionDir = null;
  snapshotRestored = false;
}
