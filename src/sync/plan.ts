/**
 * 阶段 2：同步主体（计划段）。
 *
 * 职责（方案 §5 阶段 2 / §7.B–§7.D）：
 *  - 仓库与远端预检：本地是否已接入、origin 地址是否与配置一致、嵌套仓库提示；
 *  - 远端分支发现（配置 → symref → 唯一分支 → 默认 main → 多分支明确报错）；
 *  - 本地分支对齐（不推错分支、不重复建分支）；
 *  - `fetch`（只下载对象与 FETCH_HEAD，不改工作区）；
 *  - 三方比较（基准 = merge-base 树；本机 = 工作区 blob；云端 = FETCH_HEAD 树）；
 *  - 计划结构与状态数据（ignored / invalidLocalTeams / 指纹快照）。
 *
 * 「决策前零写入」纪律（方案 §4.9 不变式 1）：本模块只写 `.git`（init / remote /
 * HEAD 对齐 / fetch），绝不写工作区、不改索引、不动分支引用内容。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { classifyFile, type ConflictOption, type FileClass, type FileVersions } from "./classify";
import type { SyncConfig } from "./config";
import {
  classifyGitError,
  splitNullTerminated,
  type GitErrorClassification,
  type GitResult,
  type GitRunOptions,
} from "./git-runner";
import { validateTeamDefinition } from "../team/schema";

/** 注入式 git 执行器（生产为 git-runner 的 runGit）。 */
export type GitRun = (args: string[], options: GitRunOptions) => Promise<GitResult>;

/** 网络命令（fetch/push/ls-remote）默认硬超时。 */
export const NETWORK_GIT_TIMEOUT_MS = 120_000;

/** 远端为空时使用的默认分支（无配置分支时）。 */
export const DEFAULT_BRANCH = "main";

/** 无法归因于 git 命令的失败（预检/校验/竞态），复用同一分类结构。 */
export function manualFailure(message: string, fix: string): SyncFailure {
  return {
    classification: { kind: "manual", reason: "manual", message, fix },
  };
}

export interface SyncFailure {
  classification: GitErrorClassification;
  /** 失败命令（已脱敏；来自 git 结果时填写）。 */
  command?: string;
  /** 原始 stderr（截断，供诊断）。 */
  stderr?: string;
}

/** 由 git 结果构造失败（分类 + 诊断信息）。 */
export function failureFromResult(result: GitResult): SyncFailure {
  return {
    classification: classifyGitError(result),
    command: result.command,
    stderr: result.stderr.slice(0, 2000),
  };
}

/** 失败文案（原因 + 修法），供命令层输出。 */
export function describeSyncFailure(failure: SyncFailure): string {
  const { message, fix } = failure.classification;
  return fix ? `${message}。修法：${fix}` : message;
}

export interface SyncContext {
  rootDir: string;
  teamsDir: string;
  config: SyncConfig;
  runGit: GitRun;
  networkTimeoutMs?: number;
}

/** 统一的 git 调用（本地命令）。 */
export async function runLocalGit(
  ctx: SyncContext,
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number; stdin?: string; maxBuffer?: number }
): Promise<GitResult> {
  return ctx.runGit(args, {
    cwd: ctx.teamsDir,
    env: options?.env,
    timeoutMs: options?.timeoutMs,
    stdin: options?.stdin,
    maxBuffer: options?.maxBuffer,
  });
}

/** 网络命令（fetch/push/ls-remote）带硬超时。 */
export async function runNetworkGit(
  ctx: SyncContext,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<GitResult> {
  return runLocalGit(ctx, args, {
    timeoutMs: options?.timeoutMs ?? ctx.networkTimeoutMs ?? NETWORK_GIT_TIMEOUT_MS,
  });
}

// ── 仓库/远端预检 ────────────────────────────────────────────

export interface RepoState {
  /** teams/ 自身是一个 git 仓库。 */
  hasRepo: boolean;
  /** teams/ 位于另一个 git 仓库内（dotfiles 场景）——预检需警告，不静默改写。 */
  nestedInsideOtherRepo: boolean;
  originUrl: string | null;
  /** 当前 HEAD 指向的分支名（unborn 也算；游离 HEAD/读取失败为 null）。 */
  headBranch: string | null;
  gitDir: string;
}

function normalizePath(path: string): string {
  // 去掉尾部分隔符；realpath 已解析符号链接
  return path.replace(/[\\/]+$/, "");
}

/** 探测 teams/ 的仓库状态（只读）。 */
export async function inspectRepo(ctx: SyncContext): Promise<RepoState> {
  const state: RepoState = {
    hasRepo: false,
    nestedInsideOtherRepo: false,
    originUrl: null,
    headBranch: null,
    gitDir: "",
  };

  const top = await runLocalGit(ctx, ["rev-parse", "--show-toplevel"]);
  if (top.ok) {
    const topPath = top.stdout.trim();
    // rev-parse 输出已是绝对路径；比较前解析符号链接（macOS /tmp → /private/tmp）
    let topReal = topPath;
    let teamsReal = ctx.teamsDir;
    try {
      topReal = normalizePath(realpathSync(topPath));
      teamsReal = normalizePath(realpathSync(ctx.teamsDir));
    } catch {
      /* 保持原值 */
    }
    if (topReal === teamsReal) {
      state.hasRepo = true;
    } else {
      state.nestedInsideOtherRepo = true;
    }
  }

  if (state.hasRepo) {
    const gitDir = await runLocalGit(ctx, ["rev-parse", "--absolute-git-dir"]);
    if (gitDir.ok) state.gitDir = gitDir.stdout.trim();

    const url = await runLocalGit(ctx, ["config", "--get", "remote.origin.url"]);
    if (url.ok && url.stdout.trim().length > 0) state.originUrl = url.stdout.trim();

    const head = await runLocalGit(ctx, ["symbolic-ref", "--short", "HEAD"]);
    if (head.ok && head.stdout.trim().length > 0) state.headBranch = head.stdout.trim();
  }

  return state;
}

// ── 分支发现与对齐 ───────────────────────────────────────────

export type BranchSource = "config" | "symref" | "single" | "default";

export interface PreparedRepository {
  branch: string;
  branchSource: BranchSource;
  emptyRemote: boolean;
  /** origin 地址与配置不一致且用户确认改用配置地址。 */
  remoteUrlChanged: boolean;
  state: RepoState;
}

/** 解析 `git ls-remote --heads` 输出（`<sha>\trefs/heads/<name>`）。 */
export function parseRemoteHeadNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ref = line.slice(tab + 1).trim();
    const m = /^refs\/heads\/(.+)$/.exec(ref);
    if (m) names.push(m[1]);
  }
  return names;
}

/** 解析 `git ls-remote --symref <remote> HEAD` 的 `ref: refs/heads/X\tHEAD`。 */
export function parseSymrefHead(stdout: string): string | null {
  const m = /^ref:\s+refs\/heads\/(.+?)\s+HEAD\s*$/m.exec(stdout);
  return m ? m[1] : null;
}

/**
 * 远端分支发现（方案 §7.D 第 1 步回退规则）：
 * 配置分支 → 远端 HEAD 符号引用 → 唯一分支 → 空远端用配置/默认 main → 多分支歧义报错。
 */
export async function discoverRemoteBranch(
  ctx: SyncContext,
  configuredBranch: string
): Promise<
  | { ok: true; branch: string; source: BranchSource; emptyRemote: boolean }
  | { ok: false; failure: SyncFailure }
> {
  const headsResult = await runNetworkGit(ctx, ["ls-remote", "--heads", "origin"]);
  if (!headsResult.ok) {
    return { ok: false, failure: failureFromResult(headsResult) };
  }
  const headNames = parseRemoteHeadNames(headsResult.stdout);

  if (headNames.length === 0) {
    const branch = configuredBranch || DEFAULT_BRANCH;
    return { ok: true, branch, source: configuredBranch ? "config" : "default", emptyRemote: true };
  }

  if (configuredBranch) {
    return { ok: true, branch: configuredBranch, source: "config", emptyRemote: false };
  }

  const symrefResult = await runNetworkGit(ctx, ["ls-remote", "--symref", "origin", "HEAD"]);
  const symBranch = symrefResult.ok ? parseSymrefHead(symrefResult.stdout) : null;
  if (symBranch && headNames.includes(symBranch)) {
    return { ok: true, branch: symBranch, source: "symref", emptyRemote: false };
  }

  if (headNames.length === 1) {
    return { ok: true, branch: headNames[0], source: "single", emptyRemote: false };
  }

  return {
    ok: false,
    failure: manualFailure(
      `远端存在多个分支（${headNames.join("、")}），无法自动确定要同步的分支`,
      "在 /team setting → 云同步（机器级）中显式设置分支后重试"
    ),
  };
}

/**
 * 准备仓库与远端（可能写 `.git`，不碰工作区）：
 * 初始化仓库 → 确保 origin 指向配置地址 → 分支发现 → 本地分支对齐（HEAD 指向目标分支）。
 */
export async function ensureRemoteAndBranch(
  ctx: SyncContext,
  options?: {
    /** origin 地址与配置不一致时的确认（false = 用户取消）。 */
    onRemoteUrlChanged?: (currentUrl: string, configuredUrl: string) => Promise<boolean>;
  }
): Promise<{ ok: true; prepared: PreparedRepository } | { ok: false; failure: SyncFailure; cancelled?: boolean }> {
  if (!ctx.config.remoteUrl) {
    return { ok: false, failure: manualFailure("尚未配置云同步仓库地址", "运行 /team sync 按引导填写仓库地址") };
  }

  let state = await inspectRepo(ctx);
  if (!state.hasRepo) {
    mkdirSync(ctx.teamsDir, { recursive: true });
    const init = await runLocalGit(ctx, ["init", "--quiet"]);
    if (!init.ok) return { ok: false, failure: failureFromResult(init) };
    state = await inspectRepo(ctx);
    if (!state.hasRepo) {
      return {
        ok: false,
        failure: manualFailure(
          "初始化 git 仓库失败",
          `检查 ${ctx.teamsDir} 的访问权限，或手工执行 git init 后重试`
        ),
      };
    }
  }

  // 确保 origin 指向配置地址
  let remoteUrlChanged = false;
  if (!state.originUrl) {
    const add = await runLocalGit(ctx, ["remote", "add", "--", "origin", ctx.config.remoteUrl]);
    if (!add.ok) return { ok: false, failure: failureFromResult(add) };
  } else if (state.originUrl !== ctx.config.remoteUrl) {
    const confirmed = options?.onRemoteUrlChanged
      ? await options.onRemoteUrlChanged(state.originUrl, ctx.config.remoteUrl)
      : false;
    if (!confirmed) {
      return {
        ok: false,
        cancelled: true,
        failure: manualFailure(
          "本地仓库的远端地址与配置不一致，已中止",
          "确认是否改用配置中的地址（换地址会先在本地留备份引用），或修正配置"
        ),
      };
    }
    const setUrl = await runLocalGit(ctx, ["remote", "set-url", "--", "origin", ctx.config.remoteUrl]);
    if (!setUrl.ok) return { ok: false, failure: failureFromResult(setUrl) };
    remoteUrlChanged = true;
  }

  // 分支发现
  const discovery = await discoverRemoteBranch(ctx, ctx.config.branch);
  if (!discovery.ok) return { ok: false, failure: discovery.failure };
  const { branch, source, emptyRemote } = discovery;

  // 本地分支对齐：HEAD 必须指向目标分支；目标分支不存在时从当前 tip 创建
  if (state.headBranch !== branch) {
    const exists = await runLocalGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!exists.ok) {
      const tip = await runLocalGit(ctx, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (tip.ok && tip.stdout.trim().length > 0) {
        // 用零值 old 保证并发下不会覆盖已存在的分支
        await runLocalGit(ctx, [
          "update-ref",
          `refs/heads/${branch}`,
          tip.stdout.trim(),
          "0000000000000000000000000000000000000000",
        ]);
      }
    }
    const symref = await runLocalGit(ctx, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    if (!symref.ok) return { ok: false, failure: failureFromResult(symref) };
    state = { ...state, headBranch: branch };
  }

  return {
    ok: true,
    prepared: { branch, branchSource: source, emptyRemote, remoteUrlChanged, state },
  };
}

/** fetch 远端分支到 FETCH_HEAD（空远端跳过）。 */
export async function fetchRemote(
  ctx: SyncContext,
  prepared: PreparedRepository
): Promise<{ ok: true; remoteSha: string } | { ok: false; failure: SyncFailure }> {
  if (prepared.emptyRemote) {
    return { ok: true, remoteSha: "" };
  }

  const fetch = await runNetworkGit(ctx, ["fetch", "--no-tags", "origin", "--", prepared.branch]);
  if (!fetch.ok) {
    if (/couldn't find remote ref|does not appear to be a git repository|not found/i.test(fetch.stderr)) {
      return {
        ok: false,
        failure: manualFailure(
          `远端分支 ${prepared.branch} 不存在`,
          `确认远端分支名（当前配置/探测为 ${prepared.branch}），或在 /team setting 中修改`
        ),
      };
    }
    return { ok: false, failure: failureFromResult(fetch) };
  }

  const head = await runLocalGit(ctx, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD"]);
  if (!head.ok || head.stdout.trim().length === 0) {
    return {
      ok: false,
      failure: manualFailure("fetch 成功但未能读取 FETCH_HEAD", "重新运行 /team sync"),
    };
  }
  return { ok: true, remoteSha: head.stdout.trim() };
}

// ── 工作区扫描与树枚举 ────────────────────────────────────────

export interface LocalFileInfo {
  /** blob id（经属性/换行过滤，与提交内容一致）。 */
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface TreeEntry {
  path: string;
  mode: string;
  blob: string;
}

export type LocalFiles = Record<string, LocalFileInfo>;

/** 列出工作区文件（排除 .git；相对路径统一用 `/`）。 */
export function listWorktreeFiles(teamsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(teamsDir, "");
  return out;
}

/** 顶层团队 YAML（本插件管理的唯一路径集合）。 */
export function isTopLevelTeamYaml(path: string): boolean {
  return !path.includes("/") && path.endsWith(".yaml");
}

/** 扫描工作区：每个文件的 blob id（git 语义）+ 大小/时间（TOCTOU 指纹）。 */
export async function scanLocalFiles(ctx: SyncContext): Promise<LocalFiles> {
  const files: LocalFiles = {};
  for (const rel of listWorktreeFiles(ctx.teamsDir)) {
    const abs = join(ctx.teamsDir, rel);
    const hashed = await runLocalGit(ctx, ["hash-object", `--path=${rel}`, "--", abs]);
    if (!hashed.ok) continue; // 读不到的文件不参与计划
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(abs);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* 忽略：文件刚被删除 */
    }
    files[rel] = { hash: hashed.stdout.trim(), size, mtimeMs };
  }
  return files;
}

/** 解析 `git ls-tree -r -z` 输出（仅 blob 条目）。 */
export function parseLsTreeZ(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of splitNullTerminated(stdout)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta.length < 3 || meta[1] !== "blob") continue;
    entries.push({ mode: meta[0], blob: meta[2], path: record.slice(tab + 1) });
  }
  return entries;
}

async function listTree(ctx: SyncContext, rev: string): Promise<{ ok: true; entries: TreeEntry[] } | { ok: false; failure: SyncFailure }> {
  const res = await runLocalGit(ctx, ["ls-tree", "-r", "-z", rev]);
  if (!res.ok) return { ok: false, failure: failureFromResult(res) };
  return { ok: true, entries: parseLsTreeZ(res.stdout) };
}

async function revParse(ctx: SyncContext, args: string[]): Promise<string> {
  const res = await runLocalGit(ctx, ["rev-parse", "--verify", "--quiet", ...args]);
  return res.ok ? res.stdout.trim() : "";
}

// ── 计划构建 ─────────────────────────────────────────────────

export interface SyncPlanFlags {
  /** 无共同祖先（含首次接入与远端重建）。 */
  firstAttach: boolean;
  emptyRemote: boolean;
  remoteUrlChanged: boolean;
}

export interface IgnoredSummary {
  /** 子目录中的 yaml（透传、不决策）。 */
  nestedYaml: string[];
  /** 本地被改过、但不参与上传的非团队文件。 */
  nonYamlLocalModified: string[];
}

export interface InvalidTeamFile {
  name: string;
  errors: string[];
}

export interface SyncPlan {
  flags: SyncPlanFlags;
  actions: FileClass[];
  ignored: IgnoredSummary;
  invalidLocalTeams: InvalidTeamFile[];
  remoteSha: string;
  branch: string;
}

/** 应用阶段所需快照（TOCTOU 校验、最终树构造、工作区落盘）。 */
export interface PlanSnapshot {
  branch: string;
  /** teams/ 的绝对 git 目录（临时索引等内部文件的位置）。 */
  gitDir: string;
  remoteSha: string;
  localSha: string;
  baseTree: string;
  remoteTree: string;
  localTree: string;
  firstAttach: boolean;
  emptyRemote: boolean;
  remoteUrlChanged: boolean;
  baseEntries: TreeEntry[];
  remoteEntries: TreeEntry[];
  localEntries: TreeEntry[];
  localFiles: LocalFiles;
  /** 需要 TOCTOU 校验的路径（管理路径 + 远端树路径）→ 计划时的本地指纹。 */
  fingerprints: Record<string, LocalFileInfo | null>;
}

export interface PreparePlanResult {
  plan: SyncPlan;
  snapshot: PlanSnapshot;
}

export interface BuildPlanInput {
  ctx: SyncContext;
  prepared: PreparedRepository;
  remoteSha: string;
}

/**
 * 三方比较并构建计划（纯读；不写任何文件）。
 * 基准 = merge-base(本地分支, FETCH_HEAD) 的树；无共同祖先 → 基准为空。
 */
export async function buildSyncPlan(
  input: BuildPlanInput
): Promise<{ ok: true; result: PreparePlanResult } | { ok: false; failure: SyncFailure }> {
  const { ctx, prepared, remoteSha } = input;
  const branch = prepared.branch;

  const localSha = await revParse(ctx, [`refs/heads/${branch}`]);
  const remoteTree = remoteSha ? await revParse(ctx, [`${remoteSha}^{tree}`]) : "";
  const localTree = localSha ? await revParse(ctx, [`${localSha}^{tree}`]) : "";

  let firstAttach = false;
  let baseCommit = "";
  if (localSha && remoteSha) {
    const mergeBase = await runLocalGit(ctx, ["merge-base", localSha, remoteSha]);
    if (mergeBase.ok && mergeBase.stdout.trim().length > 0) {
      baseCommit = mergeBase.stdout.trim();
    } else {
      firstAttach = true;
    }
  } else {
    firstAttach = true;
  }
  const baseTree = baseCommit ? await revParse(ctx, [`${baseCommit}^{tree}`]) : "";

  const baseEntries = baseTree ? (await listTree(ctx, baseTree)) : { ok: true as const, entries: [] };
  if (!baseEntries.ok) return { ok: false, failure: baseEntries.failure };
  const remoteEntriesResult = remoteTree ? await listTree(ctx, remoteTree) : { ok: true as const, entries: [] };
  if (!remoteEntriesResult.ok) return { ok: false, failure: remoteEntriesResult.failure };
  const localEntriesResult = localTree ? await listTree(ctx, localTree) : { ok: true as const, entries: [] };
  if (!localEntriesResult.ok) return { ok: false, failure: localEntriesResult.failure };

  const baseMap = new Map(baseEntries.entries.map((e) => [e.path, e]));
  const remoteMap = new Map(remoteEntriesResult.entries.map((e) => [e.path, e]));
  const localTreeMap = new Map(localEntriesResult.entries.map((e) => [e.path, e]));

  const localFiles = await scanLocalFiles(ctx);

  // 管理路径 = 三方顶层 *.yaml 的并集
  const managedPaths = new Set<string>();
  for (const path of [...baseMap.keys(), ...remoteMap.keys(), ...Object.keys(localFiles)]) {
    if (isTopLevelTeamYaml(path)) managedPaths.add(path);
  }

  const actions: FileClass[] = [];
  for (const path of [...managedPaths].sort()) {
    const versions: FileVersions = {
      path,
      base: baseMap.get(path)?.blob ?? null,
      local: localFiles[path]?.hash ?? null,
      remote: remoteMap.get(path)?.blob ?? null,
    };
    actions.push(classifyFile(versions));
  }

  // ignored：子目录 yaml + 本地被改过的非团队文件（tracked，内容或存在性变化）
  const nestedYaml = new Set<string>();
  for (const path of [...baseMap.keys(), ...remoteMap.keys(), ...Object.keys(localFiles)]) {
    if (path.includes("/") && path.endsWith(".yaml")) nestedYaml.add(path);
  }
  const nonYamlLocalModified: string[] = [];
  for (const [path, entry] of baseMap) {
    if (isTopLevelTeamYaml(path)) continue;
    const local = localFiles[path];
    if (!local || local.hash !== entry.blob) nonYamlLocalModified.push(path);
  }

  // invalidLocalTeams：本地顶层 yaml 的格式校验（只报告，不阻断）
  const invalidLocalTeams = await listInvalidTeamFiles(ctx, localFiles);

  // TOCTOU 指纹：管理路径 + 远端树路径（可能被「云端为准」覆盖）
  const fingerprintPaths = new Set<string>([...managedPaths, ...remoteMap.keys()]);
  const fingerprints: Record<string, LocalFileInfo | null> = {};
  for (const path of fingerprintPaths) {
    fingerprints[path] = localFiles[path] ?? null;
  }

  const plan: SyncPlan = {
    flags: { firstAttach, emptyRemote: prepared.emptyRemote, remoteUrlChanged: prepared.remoteUrlChanged },
    actions,
    ignored: { nestedYaml: [...nestedYaml].sort(), nonYamlLocalModified: nonYamlLocalModified.sort() },
    invalidLocalTeams,
    remoteSha,
    branch,
  };

  const snapshot: PlanSnapshot = {
    branch,
    gitDir: prepared.state.gitDir,
    remoteSha,
    localSha,
    baseTree,
    remoteTree,
    localTree,
    firstAttach,
    emptyRemote: prepared.emptyRemote,
    remoteUrlChanged: prepared.remoteUrlChanged,
    baseEntries: baseEntries.entries,
    remoteEntries: remoteEntriesResult.entries,
    localEntries: localEntriesResult.entries,
    localFiles,
    fingerprints,
  };

  return { ok: true, result: { plan, snapshot } };
}

/** 本地顶层 yaml 的格式校验（复用团队 schema；只报告不阻断）。 */
export async function listInvalidTeamFiles(
  ctx: SyncContext,
  localFiles?: LocalFiles
): Promise<InvalidTeamFile[]> {
  const files = localFiles ?? (await scanLocalFiles(ctx));
  const invalid: InvalidTeamFile[] = [];
  for (const rel of Object.keys(files)) {
    if (!isTopLevelTeamYaml(rel)) continue;
    const name = rel.slice(0, -".yaml".length);
    try {
      const raw = readFileSync(join(ctx.teamsDir, rel), "utf-8");
      const data = parseYaml(raw);
      const validation = validateTeamDefinition(data);
      if (!validation.valid) invalid.push({ name, errors: validation.errors });
    } catch (err) {
      invalid.push({ name, errors: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return invalid;
}

/** 计划中需要用户决策的冲突团队（阶段 2：检测到即安全中止）。 */
export function listConflicts(plan: SyncPlan): { path: string; options: ConflictOption[] }[] {
  return plan.actions
    .filter((action): action is Extract<FileClass, { kind: "conflict" }> => action.kind === "conflict")
    .map((action) => ({ path: action.path, options: action.options }));
}

/** 计划摘要（命令层展示；纯函数便于单测）。 */
export function formatPlanSummary(plan: SyncPlan): string {
  const downloads = plan.actions.filter((a) => a.kind === "remote-modified" || a.kind === "remote-only");
  const uploads = plan.actions.filter((a) => a.kind === "local-modified" || a.kind === "local-only");
  const deletesRemote = plan.actions.filter((a) => a.kind === "local-deleted");
  const deletesLocal = plan.actions.filter((a) => a.kind === "remote-deleted");
  const lines: string[] = [`云同步计划（分支 ${plan.branch}）`];
  lines.push(`  下载：${downloads.length}${downloads.length ? `（${downloads.map((a) => a.path).join("、")}）` : ""}`);
  lines.push(`  上传：${uploads.length}${uploads.length ? `（${uploads.map((a) => a.path).join("、")}）` : ""}`);
  lines.push(
    `  删除：${deletesRemote.length + deletesLocal.length}${
      deletesRemote.length + deletesLocal.length
        ? `（云端删：${deletesRemote.map((a) => a.path).join("、") || "无"}；本机删：${
            deletesLocal.map((a) => a.path).join("、") || "无"
          }）`
        : ""
    }`
  );
  if (plan.flags.firstAttach) lines.push("  ⚠️ 首次接入：将建立与云端的对应关系");
  if (plan.flags.emptyRemote) lines.push("  云端为空仓库：将创建首个提交");
  if (plan.invalidLocalTeams.length > 0) {
    lines.push(`  ⚠️ ${plan.invalidLocalTeams.length} 个团队文件校验失败（仍会同步，修复后可用）`);
  }
  return lines.join("\n");
}

/** 待删除路径（本机删除动作；both-deleted 无需动作也不提示）。 */
export function listLocalDeletePaths(plan: SyncPlan): string[] {
  return plan.actions.filter((a) => a.kind === "remote-deleted").map((a) => a.path);
}

/** 待删除路径（云端删除动作 = 本机删除传播）。 */
export function listRemoteDeletePaths(plan: SyncPlan): string[] {
  return plan.actions.filter((a) => a.kind === "local-deleted").map((a) => a.path);
}

// ── TOCTOU 校验 ──────────────────────────────────────────────

/**
 * 应用前复核（方案 §7.D 第 3 步）：FETCH_HEAD、本地分支 tip 与计划涉及的每个
 * 本地文件（blob id + 存在性）必须与计划时一致；不一致即中止（零改动）。
 * mtime 只作诊断（内容哈希相同即安全，避免「仅 touch 即中止」的假阳性）。
 */
export async function verifyPlanFingerprints(
  ctx: SyncContext,
  snapshot: PlanSnapshot
): Promise<SyncFailure | null> {
  const stale = (what: string): SyncFailure =>
    manualFailure(
      `计划期间 ${what} 发生变化，已中止（未做任何改动）`,
      "重新运行 /team sync（会按最新状态重算）"
    );

  if (snapshot.remoteSha) {
    const fetchHead = await revParse(ctx, ["FETCH_HEAD"]);
    if (fetchHead !== snapshot.remoteSha) return stale("云端提交（FETCH_HEAD）");
  }

  const tip = await revParse(ctx, [`refs/heads/${snapshot.branch}`]);
  if (tip !== snapshot.localSha) return stale("本地分支引用");

  const current = await scanLocalFiles(ctx);
  for (const [path, expected] of Object.entries(snapshot.fingerprints)) {
    const actual = current[path];
    if (!expected) {
      if (actual) return stale(`文件 ${path}（凭空出现）`);
      continue;
    }
    if (!actual || actual.hash !== expected.hash) return stale(`文件 ${path}`);
  }
  return null;
}

// ── 残留清理（阶段 2 待办：硬杀后的可检测 + 可清理） ──────────

/**
 * 清理上次异常退出的残留（方案 §7.D 第 4 步）：
 *  - <gitdir>/sync-index-*（临时索引；本进程持有同步锁，任何存在者均为残留）
 *  - <rootDir>/sync.yaml.tmp-*（配置临时文件）
 *  - <rootDir>/sync.lock.candidate-*（候选锁文件）
 *  - 工作区/子目录中的 *.tmp-*（原子写临时文件）
 *  - .stale-* 仅在 24h 前保留期后清理（其中可能含被误夺锁的内容）
 * 返回被清理的路径列表（供诊断/测试）。绝不删除 index.lock（可能属于活跃进程）。
 */
export function cleanupSyncResiduals(ctx: SyncContext, now = Date.now()): string[] {
  const removed: string[] = [];
  const removeFile = (path: string): void => {
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch {
      /* 尽力而为 */
    }
  };

  const collect = (dir: string, predicate: (name: string) => boolean): string[] => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isFile() && predicate(e.name)).map((e) => join(dir, e.name));
  };

  // 临时索引
  const gitDir = existsSync(join(ctx.teamsDir, ".git")) ? join(ctx.teamsDir, ".git") : ctx.teamsDir;
  for (const path of collect(gitDir, (name) => name.startsWith("sync-index-"))) removeFile(path);

  // 配置临时文件 + 锁候选/陈旧残留
  for (const path of collect(ctx.rootDir, (name) => name.startsWith("sync.yaml.tmp-"))) removeFile(path);
  for (const path of collect(ctx.rootDir, (name) => name.includes(".candidate-"))) removeFile(path);
  for (const path of collect(ctx.rootDir, (name) => name.includes(".stale-"))) {
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > 24 * 60 * 60 * 1000) removeFile(path);
    } catch {
      /* ignore */
    }
  }

  // 工作区临时文件（原子写残留；不匹配 *.yaml）
  for (const rel of listWorktreeFiles(ctx.teamsDir)) {
    if (rel.includes(".tmp-")) removeFile(join(ctx.teamsDir, rel));
  }

  return removed;
}

/** 未提交的团队改动数（工作区 vs 本地分支 tip；供 status 显示）。 */
export async function countUncommittedTeamChanges(
  ctx: SyncContext,
  branch: string
): Promise<number> {
  const localSha = await revParse(ctx, [`refs/heads/${branch}`]);
  const localTree = localSha ? await revParse(ctx, [`${localSha}^{tree}`]) : "";
  const entries = localTree ? await listTree(ctx, localTree) : { ok: true as const, entries: [] };
  const tipMap = new Map((entries.ok ? entries.entries : []).map((e) => [e.path, e.blob]));
  const localFiles = await scanLocalFiles(ctx);

  const paths = new Set<string>();
  for (const path of [...tipMap.keys(), ...Object.keys(localFiles)]) {
    if (isTopLevelTeamYaml(path)) paths.add(path);
  }
  let changed = 0;
  for (const path of paths) {
    if ((tipMap.get(path) ?? null) !== (localFiles[path]?.hash ?? null)) changed++;
  }
  return changed;
}

/** index.lock 是否存在（并发/异常退出预检；不删除）。 */
export function hasIndexLock(gitDir: string): boolean {
  try {
    return statSync(join(gitDir, "index.lock")).isFile();
  } catch {
    return false;
  }
}
