/**
 * 云同步的机器级配置（`<rootDir>/sync.yaml`）。
 *
 * 为什么独立文件而不是 `settings.yaml`（方案 §4.5）：仓库地址与开关是
 * **机器级**配置，而 `settings.yaml` 处于「临时设置（仅当前会话）+ /team resume
 * 快照恢复」两套机制之下——放进后者会出现「仅本会话生效的仓库地址」「resume
 * 恢复旧地址」这类无意义状态，还必须在快照字段白名单里登记（漏登记 = 静默丢失）。
 *
 * 本模块只做数据层：读取/写入/地址校验/展示脱敏，全部纯函数或同步 IO；
 * 不调用 git、不签出任何状态（阶段 2 的命令层负责编排与引导）。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** 云同步配置（与方案 §7.B 的类型定义一致）。 */
export interface SyncConfig {
  /** 总开关；只有显式 true 才算启用（缺省/非法值一律视为未启用）。 */
  enabled: boolean;
  /** 远端仓库地址；空字符串 = 未配置。 */
  remoteUrl: string;
  /** 分支名；空字符串 = 自动探测（配置优先 → 远端 HEAD 符号引用 → 唯一分支 → 默认 main）。 */
  branch: string;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  remoteUrl: "",
  branch: "",
};

const SYNC_CONFIG_FILE = "sync.yaml";

export function getSyncConfigPath(rootDir: string): string {
  return join(rootDir, SYNC_CONFIG_FILE);
}

/** 去首尾空白（用户经输入框配置时可能带尾随换行/空格）。 */
export function normalizeRemoteUrl(value: string): string {
  return value.trim();
}

/**
 * 校验仓库地址（方案 §7.B 配置校验规则）。
 * 返回可读的失败原因；`null` = 通过。
 *
 * 允许：`https://`、`ssh://`、`git@host:path`（scp 形态）、`file://`、本地绝对路径。
 * 拒绝：以 `-` 开头的值（会被 git 当成命令选项）、`https://` 内嵌任何 userinfo
 * （`ssh://git@host/path` 允许——`git` 不是秘密）、其它协议、控制字符。
 */
export function validateRemoteUrl(remoteUrl: unknown): string | null {
  if (typeof remoteUrl !== "string") {
    return "仓库地址必须是字符串";
  }
  const value = normalizeRemoteUrl(remoteUrl);
  if (value.length === 0) {
    return "仓库地址不能为空";
  }
  if (value.startsWith("-")) {
    return "仓库地址不能以 `-` 开头（会被 git 当作命令选项）";
  }
  // 控制字符：换行/回车/NUL 等会把一个参数拆成多个或污染输出
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return "仓库地址不能包含控制字符（换行、制表符等）";
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "https" || scheme === "ssh" || scheme === "file") {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return "仓库地址格式非法";
      }
      // 所有 scheme 一律拒绝内嵌密码（审查 #4）：密码会明文落盘，且会出现在
      // 诊断命令串里。ssh://git@... 只允许用户名（git 不是秘密）。
      if (parsed.password) {
        return "仓库地址不能内嵌密码（请改用 SSH 密钥或系统凭据助手）";
      }
      if ((scheme === "https" || scheme === "file") && parsed.username) {
        return "仓库地址不能内嵌用户名或密码（请改用 SSH 或系统凭据助手）";
      }
      if (scheme === "file") {
        if (parsed.hostname && parsed.hostname !== "localhost") {
          return "file:// 地址只支持本机（空主机名或 localhost）";
        }
        if (parsed.pathname.length === 0 || parsed.pathname === "/") {
          return "仓库地址缺少路径";
        }
        return null;
      }
      if (parsed.hostname.length === 0) {
        return "仓库地址缺少主机名";
      }
      if (parsed.pathname.length === 0 || parsed.pathname === "/") {
        return "仓库地址缺少仓库路径";
      }
      return null;
    }
    return `不支持的地址协议：${scheme}://（支持 https://、ssh://、git@host:path、file:// 或本地绝对路径）`;
  }

  // scp 形态：user@host:path（仓库路径不能为空、不能含空白）
  if (/^[^@/\s:]+@[^:/\s]+:[^\s]+$/.test(value)) {
    return null;
  }

  // 本地绝对路径（POSIX；Windows 盘符路径做防御性识别）
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return null;
  }

  return "仓库地址必须是 https://、ssh://、git@host:path、file:// 或本地绝对路径";
}

export function isValidRemoteUrl(remoteUrl: unknown): boolean {
  return validateRemoteUrl(remoteUrl) === null;
}

/**
 * 展示脱敏（方案 §3.7 / §7.B）：任何展示地址的位置都必须经此处理。
 *
 * - `https://user[:pass]@host/path` → `https://***@host/path`
 *   （https 的 userinfo 常放 token，整体遮蔽）
 * - 其它协议只遮蔽密码：`ssh://user:pass@host/path` → `ssh://user:***@host/path`
 *   （用户名不是秘密，保留可读性；`git@host:path` 形态不变）
 */
export function maskRemoteUrl(remoteUrl: string): string {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(remoteUrl);
  if (!schemeMatch) return remoteUrl;

  const scheme = schemeMatch[1].toLowerCase();
  // userinfo 只在 authority（`://` 之后、首个 /?# 之前）内查找；
  // 路径/查询里的 `@` 不属于 userinfo（审查 #5）。
  const rest = remoteUrl.slice(schemeMatch[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd < 0 ? "" : rest.slice(authorityEnd);

  const at = authority.lastIndexOf("@");
  if (at < 0) return remoteUrl;

  const userinfo = authority.slice(0, at);
  const hostPart = authority.slice(at + 1);
  if (scheme === "https" || scheme === "http") {
    return `${schemeMatch[1]}://***@${hostPart}${tail}`;
  }
  const colon = userinfo.indexOf(":");
  if (colon >= 0) {
    return `${schemeMatch[1]}://${userinfo.slice(0, colon)}:***@${hostPart}${tail}`;
  }
  return remoteUrl;
}

/** 非法地址 warn 去重（每文件路径一次；启动检测/状态查询可能高频调用，防刷屏）。 */
const warnedInvalidRemoteUrl = new Set<string>();

/**
 * 读取 `sync.yaml`。
 * - 文件缺失 / 不可读 / YAML 解析失败 / 根不是对象 → `null`（视为未配置，fail-open）
 * - 字段类型非法 → 回退默认值（`enabled` 严格 `=== true`）
 */
export function loadSyncConfig(rootDir: string): SyncConfig | null {
  const filePath = getSyncConfigPath(rootDir);
  if (!existsSync(filePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.warn(
      `[top-notch-team] 无法读取云同步配置 ${filePath}：${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    console.warn(
      `[top-notch-team] 云同步配置解析失败（按未配置处理）${filePath}：${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    console.warn(`[top-notch-team] 云同步配置根节点不是对象（按未配置处理）：${filePath}`);
    return null;
  }

  const obj = data as Record<string, unknown>;

  // 地址校验在**读取时**执行（审查 #3）：手工编辑/修复后的 sync.yaml 可能含有
  // 非法值（如 `--upload-pack=evil`），若原样返回给命令层，非法值会被 git 当作
  // 命令选项。非法值一律清空并 warn（保留 enabled 等其余字段，仍视为未配置地址）。
  let remoteUrl = typeof obj.remoteUrl === "string" ? normalizeRemoteUrl(obj.remoteUrl) : "";
  if (remoteUrl.length > 0) {
    const error = validateRemoteUrl(remoteUrl);
    if (error) {
      if (!warnedInvalidRemoteUrl.has(filePath)) {
        warnedInvalidRemoteUrl.add(filePath);
        console.warn(
          `[top-notch-team] sync.yaml 中的仓库地址非法（已清空，需重新配置）：${error}\n文件：${filePath}`
        );
      }
      remoteUrl = "";
    } else {
      // 地址恢复合法：复位 warn-once，后续再次非法时能重新告警（审查建议 #6）
      warnedInvalidRemoteUrl.delete(filePath);
    }
  } else {
    warnedInvalidRemoteUrl.delete(filePath);
  }

  return {
    enabled: obj.enabled === true,
    remoteUrl,
    branch: typeof obj.branch === "string" ? obj.branch : "",
  };
}

/**
 * 原子写入 `sync.yaml`（同目录临时文件 + rename）。
 * 未知键在写回时保留（用户可能手工添加了注释性/未来字段；
 * 写回只覆盖本插件管理的三个键）。
 */
export function saveSyncConfig(config: SyncConfig, rootDir: string): void {
  const filePath = getSyncConfigPath(rootDir);
  const remoteUrl = normalizeRemoteUrl(config.remoteUrl);
  // 写入侧同样拒绝非法地址（写入是用户显式动作，非法值应显式报错而非落盘）
  if (remoteUrl.length > 0) {
    const error = validateRemoteUrl(remoteUrl);
    if (error) {
      throw new Error(`拒绝写入非法仓库地址：${error}`);
    }
  }

  const existing = readRawConfigObject(filePath);
  const merged: Record<string, unknown> = {
    ...existing,
    enabled: config.enabled,
    remoteUrl,
    branch: config.branch,
  };

  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }

  const yaml = stringifyYaml(merged, { lineWidth: 120 });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  // mode 0600（审查 #4）：配置可能含仓库地址等敏感信息，不让同机其他用户可读；
  // 先清掉可能残留的同 pid 临时文件，保证 mode 生效。
  rmSync(tmpPath, { force: true });
  try {
    writeFileSync(tmpPath, yaml, { encoding: "utf-8", mode: 0o600 });
    syncFileBestEffort(tmpPath); // 掉电时不留下空配置文件（尽力而为）
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 任一步失败（含临时文件自身写入失败）都清理临时文件后原样上抛，
    // 旧配置保持不变（审查建议 #3，与 store.ts 的 writeFileAtomic 同款）。
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
  // 保存成功：复位 warn-once（审查建议 #6）
  warnedInvalidRemoteUrl.delete(filePath);
}

/** 尽力而为地把文件数据刷到磁盘（fsync 失败不改变写入语义，只影响掉电持久性）。 */
function syncFileBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 读原始 YAML 对象（用于保留未知键）；缺失/损坏 → 空对象。 */
function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const data = parseYaml(readFileSync(filePath, "utf-8"));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* 损坏文件：以空对象为基，覆盖写入 */
  }
  return {};
}
