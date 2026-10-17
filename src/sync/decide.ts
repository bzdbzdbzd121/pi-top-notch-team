/**
 * 阶段 4：冲突决策模型、归档/导入规则、RPC 与无 UI 降级（方案 §3.4 / §4.4 / §4.8 /
 * §7.C / §7.D 第 2 步 / §7.F）。
 *
 * 本模块是**纯决策层**：形态判定、选项集、决策 → 生效动作、导入名与导入内容、
 * 摘要文案、差异文本生成（写系统临时目录，不写 teams/ 也不写归档目录）。
 * 真正的落盘（归档、导入文件、提交树）在 apply.ts 内完成并纳入回滚日志。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ConflictOption } from "./classify";
import {
  listConflicts,
  runLocalGit,
  type PlanSnapshot,
  type SyncContext,
  type SyncPlan,
} from "./plan";
import { validateTeamDefinition } from "../team/schema";
import type { TeamDefinition } from "../team/definition";

// ── 形态与选项集（§7.C 真值表 #5/#6/#7/#8）──────────────────

export type ConflictShape = "both-modified" | "add-add" | "delete-modify" | "modify-delete";

/** 冲突形态判定（依据快照的三方存在性，与 §7.C 分类同源）。 */
export function conflictShapeFor(snapshot: PlanSnapshot, path: string): ConflictShape {
  const hasBase = snapshot.baseEntries.some((e) => e.path === path);
  const hasLocal = snapshot.localFiles[path] !== undefined;
  const hasRemote = snapshot.remoteEntries.some((e) => e.path === path);
  if (hasLocal && !hasRemote) return "modify-delete";
  if (!hasLocal && hasRemote) return "delete-modify";
  if (!hasBase && hasLocal && hasRemote) return "add-add";
  // 兜底：两边都存在且内容不同（含基准存在）→ 两边都改（选项集最宽松，绝不因判定异常拒绝决策）
  return "both-modified";
}

export interface ConflictChoice {
  value: ConflictOption;
  label: string;
}

/**
 * 选项集与展示标签（§3.4 + §7.C 的「是否提问/动作」列）。
 * 顺序刻意与 classify.ts 的 `options` 一致（跨模块一致性有测试锁定）。
 */
export function conflictChoices(shape: ConflictShape): ConflictChoice[] {
  switch (shape) {
    case "both-modified":
    case "add-add":
      return [
        { value: "keep-local", label: "保留本地（本机版本继续作为该团队并上传；云端版本归档）" },
        { value: "take-remote", label: "采用远端（云端版本成为该团队；本机版本归档）" },
        { value: "keep-both", label: "两边都留（本机版本继续；云端版本导为新团队并归档）" },
      ];
    case "delete-modify":
      // #7 本机删 + 云端改：只有两个选项
      return [
        { value: "take-remote", label: "恢复云端（把云端版本取回本机）" },
        { value: "keep-local", label: "保持删除（本机保持删除；云端版本归档）" },
      ];
    case "modify-delete":
      // #8 本机改 + 云端删：只有两个选项
      return [
        { value: "keep-local", label: "保留本机（重新上传本机版本）" },
        { value: "take-remote", label: "接受删除（本机版本归档后删除）" },
      ];
  }
}

export interface ConflictDecision {
  path: string;
  /** 语义随形态而定（同 classify.ts 的选项语义）。 */
  choice: ConflictOption;
  /** 仅 keep-both：云端版本导入后的新团队名。 */
  importName?: string;
}

/** 决策的生效动作：工作区写入 + 索引动作 + 是否导入云端版本。 */
export interface ConflictEffect {
  write: "none" | "remote" | "delete";
  index: "add" | "remove";
  importRemote: boolean;
}

export function conflictEffectFor(shape: ConflictShape, choice: ConflictOption): ConflictEffect {
  if (choice === "keep-both") {
    // 三选项形态专属：本机版本留在原位，云端版本另存为新团队
    return { write: "none", index: "add", importRemote: true };
  }
  switch (shape) {
    case "both-modified":
    case "add-add":
      return choice === "keep-local"
        ? { write: "none", index: "add", importRemote: false }
        : { write: "remote", index: "add", importRemote: false };
    case "delete-modify":
      // 本机已无文件：keep-local = 保持删除（提交树里也删除）
      return choice === "take-remote"
        ? { write: "remote", index: "add", importRemote: false }
        : { write: "none", index: "remove", importRemote: false };
    case "modify-delete":
      // 云端已无文件：take-remote = 接受删除
      return choice === "keep-local"
        ? { write: "none", index: "add", importRemote: false }
        : { write: "delete", index: "remove", importRemote: false };
  }
}

/**
 * 被放弃、需要留档的一侧（§3.4：冲突中被放弃的一侧都有留档）。
 * null = 没有内容被放弃（例如「恢复云端」时本机本就没有内容）。
 */
export function abandonedSideFor(shape: ConflictShape, choice: ConflictOption): "local" | "remote" | null {
  if (choice === "keep-both") return "remote"; // 两边都留：云端版本既有归档也有导入副本
  switch (shape) {
    case "both-modified":
    case "add-add":
      return choice === "keep-local" ? "remote" : "local";
    case "delete-modify":
      return choice === "keep-local" ? "remote" : null; // 保持删除→放弃云端；恢复云端→本机无内容
    case "modify-delete":
      return choice === "take-remote" ? "local" : null; // 接受删除→放弃本机；保留本机→云端无内容
  }
}

/** 决策的展示文案（用于最终计划确认与结果摘要）。 */
export function decisionSummary(shape: ConflictShape, choice: ConflictOption, importName?: string): string {
  if (shape === "both-modified" || shape === "add-add") {
    if (choice === "keep-local") return "保留本地（云端版本归档）";
    if (choice === "take-remote") return "采用远端（本机版本归档）";
    return `两边都留（云端版本导为 ${importName ?? "新团队"} 并归档）`;
  }
  if (shape === "delete-modify") {
    return choice === "take-remote" ? "恢复云端（取回云端版本）" : "保持删除（云端版本归档）";
  }
  return choice === "keep-local" ? "保留本机（重新上传）" : "接受删除（本机版本归档）";
}

// ── 新团队导入（§3.4 / §4.4：唯一名 + 内部 name 改写 + 过校验）──

/** 导入名日期戳（YYYYMMDD，与归档时间戳风格一致但只到日，便于人读）。 */
function importStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

function importSlug(path: string): string {
  const stem = path.replace(/\.yaml$/i, "");
  const slug = stem
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "team";
}

/**
 * 为每个冲突路径生成唯一导入名（仅字母数字与连字符）。
 * 与已有团队（含 `X.remote` 这类合法名）以及同批导入的其他名字都不冲突。
 */
export function resolveImportNames(
  paths: string[],
  existingNames: string[],
  now: Date
): Record<string, string> {
  // 大小写不敏感归一（macOS/Windows 的大小写不敏感文件系统上 `X.yaml` 与 `x.yaml` 是同一文件）；
  // 调用方必须传入「本机 + 基准树 + 远端树 + 同批已定名」的全部名字（见 command.ts 接线）。
  const taken = new Set(existingNames.map((name) => normalizeImportName(name)));
  const out: Record<string, string> = {};
  for (const path of paths) {
    const base = `${importSlug(path)}-remote-${importStamp(now)}`;
    let candidate = base;
    let n = 2;
    while (taken.has(normalizeImportName(candidate))) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    taken.add(normalizeImportName(candidate));
    out[path] = candidate;
  }
  return out;
}

/** 导入名与既有团队名比较用归一（去 `.yaml`、去大小写）。 */
function normalizeImportName(name: string): string {
  return name.replace(/\.yaml$/i, "").toLowerCase();
}

export interface ImportedTeam {
  ok: true;
  content: string;
  definition: TeamDefinition;
}

/**
 * 构造导入的团队 YAML：内部 `name` 改为新名，其余字段保留，并通过
 * `validateTeamDefinition`。任一环节失败都不写入 `teams/`（只留档）。
 */
export function buildImportedTeamYaml(
  remoteYaml: string,
  newName: string
): ImportedTeam | { ok: false; error: string } {
  let data: unknown;
  try {
    data = parseYaml(remoteYaml);
  } catch (err) {
    return { ok: false, error: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "内容不是团队定义（顶层必须是映射）" };
  }
  const rewritten = { ...(data as Record<string, unknown>), name: newName };
  const validation = validateTeamDefinition(rewritten);
  if (!validation.valid) {
    return { ok: false, error: `团队校验失败：${validation.errors.join("；")}` };
  }
  const definition = rewritten as unknown as TeamDefinition;
  return { ok: true, content: stringifyYaml(definition, { lineWidth: 120 }), definition };
}

// ── 差异文本（§7.D 第 2 步：系统临时目录 + git diff --no-index）──

export interface ConflictDiff {
  path: string;
  shape: ConflictShape;
  localExists: boolean;
  localSize: number;
  localMtimeMs?: number;
  remoteExists: boolean;
  remoteSize: number;
  /** 统一 diff 文本（无颜色）；失败时为空串并置 `error`。 */
  diffText: string;
  /** diff 生成失败的原因（视图降级为「仅两侧信息」）。 */
  error?: string;
  gitDir: string;
  remoteSha: string;
  teamsDir: string;
}

export interface LoadedConflictDiffs {
  diffs: Map<string, ConflictDiff>;
  /** 删除临时目录（视图关闭后调用）。 */
  cleanup: () => void;
}

/** 删除差异生成的临时目录（视图关闭后调用；幂等）。 */
export function cleanupConflictDiffs(loaded: LoadedConflictDiffs): void {
  loaded.cleanup();
}

const DIFF_LINE_CAP = 4000;

/**
 * 为每个冲突生成差异文本：两侧内容写到系统临时目录，用统一执行器跑
 * `git diff --no-index --no-color`（不写 teams/，也不写归档目录）。
 * `git diff --no-index` 在有差异时退出码为 1（不是失败），单侧缺失按空文件参与。
 */
export async function loadConflictDiffs(input: {
  ctx: SyncContext;
  snapshot: PlanSnapshot;
  paths: string[];
  tmpDir?: string;
}): Promise<LoadedConflictDiffs> {
  const { ctx, snapshot, paths } = input;
  const dir = input.tmpDir ?? mkdtempSync(join(tmpdir(), "sync-diff-"));
  const diffs = new Map<string, ConflictDiff>();
  const cleanup = (): void => {
    if (input.tmpDir === undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  for (const [index, path] of paths.entries()) {
    const shape = conflictShapeFor(snapshot, path);
    const localInfo = snapshot.localFiles[path];
    const remoteEntry = snapshot.remoteEntries.find((e) => e.path === path);
    const caseDir = join(dir, `c${index}`);

    // 本机侧内容（缺失 = 空内容，diff 显示为整段删除）
    const localAbs = join(ctx.teamsDir, path);
    let localContent: Buffer = Buffer.alloc(0);
    let localExists = false;
    try {
      if (existsSync(localAbs)) {
        localExists = true;
        localContent = readFileSync(localAbs);
      }
    } catch {
      /* 读取失败按缺失处理 */
    }

    // 云端侧内容（cat-file，二进制安全）
    let remoteContent: Buffer = Buffer.alloc(0);
    let remoteReadError: string | undefined;
    if (remoteEntry) {
      const blob = await runLocalGit(ctx, ["cat-file", "blob", remoteEntry.blob], {
        maxBuffer: 8 * 1024 * 1024,
        binaryStdout: true,
      });
      if (blob.ok) {
        remoteContent = blob.stdoutBuffer ?? Buffer.from(blob.stdout, "utf-8");
      } else {
        // 静默按空内容参与 diff 会把「云端存在」显示成「已删除」——必须显式降级
        remoteReadError = blob.stderr.trim() || blob.command;
      }
    }

    const diff: ConflictDiff = {
      path,
      shape,
      localExists,
      localSize: localContent.length,
      localMtimeMs: localInfo?.mtimeMs,
      remoteExists: remoteEntry !== undefined,
      remoteSize: remoteContent.length,
      diffText: "",
      error: remoteReadError ? `读取云端版本失败：${remoteReadError}` : undefined,
      gitDir: snapshot.gitDir,
      remoteSha: snapshot.remoteSha,
      teamsDir: ctx.teamsDir,
    };

    try {
      if (remoteReadError) throw new Error(diff.error);
      mkdirSync(caseDir, { recursive: true });
      const localFile = join(caseDir, "local.txt");
      const remoteFile = join(caseDir, "remote.txt");
      writeFileSync(localFile, localContent);
      writeFileSync(remoteFile, remoteContent);
      const result = await runLocalGit(ctx, [
        "diff",
        "--no-index",
        "--no-color",
        "--",
        localFile,
        remoteFile,
      ]);
      // exit 1 = 有差异（正常）；0 = 无差异；其它 = 失败 → 降级
      if (result.ok || result.code === 1) {
        const lines = result.stdout.split("\n");
        diff.diffText =
          lines.length > DIFF_LINE_CAP
            ? `${lines.slice(0, DIFF_LINE_CAP).join("\n")}\n…（差异过长，已截断 ${lines.length - DIFF_LINE_CAP} 行）`
            : result.stdout;
      } else {
        diff.error = result.stderr.trim() || result.command;
      }
    } catch (err) {
      diff.error = err instanceof Error ? err.message : String(err);
    }

    diffs.set(path, diff);
  }

  return { diffs, cleanup };
}

// ── 文案（§7.F）────────────────────────────────────────────

/** RPC 降级概览：两侧大小/修改时间 + 可在另一终端执行的查看命令（§4.8）。 */
export function formatConflictRpcOverview(diff: ConflictDiff): string {
  const lines: string[] = [`冲突团队：${diff.path}（${shapeLabel(diff.shape)}）`];
  lines.push(
    diff.localExists
      ? `  本机版本：${diff.localSize} 字节${
          diff.localMtimeMs !== undefined ? `（修改于 ${formatTime(diff.localMtimeMs)}）` : ""
        }`
      : "  本机版本：已删除"
  );
  lines.push(diff.remoteExists ? `  云端版本：${diff.remoteSize} 字节` : "  云端版本：已删除");
  if (diff.diffText.length > 0) {
    lines.push(`  差异已生成（${diff.diffText.split("\n").length} 行）——差异视图仅在 TUI 模式下可用`);
  } else if (diff.error) {
    lines.push(`  ⚠️ 差异生成失败（${diff.error}），请按下方命令自行比较`);
  }
  // 工作区 = teams/ 目录本身，提交树里的路径就是顶层文件名（不要再加 `teams/` 前缀，
  // 否则用户照抄会得到 `fatal: path 'teams/x.yaml' does not exist`）。路径加引号以便
  // 含空格/特殊字符的团队名可直接粘贴执行。
  const showSpec = `${diff.remoteSha}:${diff.path}`;
  const commands = [
    `  查看云端版本：git --git-dir ${shellQuote(diff.gitDir)} show ${shellQuote(showSpec)}`,
    `  查看本机版本：cat ${shellQuote(join(diff.teamsDir, diff.path))}`,
  ];
  lines.push("  人工处理命令（可在另一个终端执行）：");
  lines.push(...commands);
  return lines.join("\n");
}

function shapeLabel(shape: ConflictShape): string {
  switch (shape) {
    case "both-modified":
      return "两边都改";
    case "add-add":
      return "两边新增同名";
    case "delete-modify":
      return "本机删除 + 云端修改";
    case "modify-delete":
      return "本机修改 + 云端删除";
  }
}

/** 单引号包裹以便直接粘贴执行（内部单引号按 POSIX 规则转义）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 无交互能力时的拒绝文案（验收 6：明确拒绝 + 人工命令，不静默 no-op）。 */
export function nonInteractiveSyncMessage(): string {
  return [
    "云同步需要交互式界面（TUI/RPC）才能执行写操作：冲突决策必须由人来做（D19 不自动合并）。",
    "当前模式下的替代做法：",
    "  1) 在交互式终端运行 /team sync 完成决策与同步；",
    "  2) 只读查询用 /team sync status（不推送、不改团队文件与工作区；读取云端并更新 .git 内对象/远端跟踪引用，不写 FETCH_HEAD）；",
    "  3) 人工比较冲突（工作区就是 teams/ 本身，树路径不带 teams/ 前缀）：",
    "     git --git-dir <teams/.git> show '<远端提交>:<名字>.yaml'",
    "     cat '<teams 目录>/<名字>.yaml'",
    "     再用 /team edit 手工改写本机版本。",
  ].join("\n");
}

/**
 * 最终计划确认（§5 阶段 4：应用前展示完整变更清单）。
 * 含逐项冲突决策、新团队导入、非团队文件覆盖与归档说明。
 */
/**
 * 应用阶段会按「云端为准」覆盖、因而需要留档的非团队路径（复审建议 #8）：
 * 远端树中非管理路径且本机内容与远端不同（含**未跟踪但同名**的文件——
 * `ignored.nonYamlLocalModified` 只覆盖基准树里已跟踪的文件）。
 */
export function passthroughOverwritePaths(plan: SyncPlan, snapshot: PlanSnapshot): string[] {
  const managed = new Set(plan.actions.map((a) => a.path));
  const out: string[] = [];
  for (const entry of snapshot.remoteEntries) {
    if (managed.has(entry.path)) continue;
    const local = snapshot.localFiles[entry.path];
    if (local !== undefined && local.hash !== entry.blob) out.push(entry.path);
  }
  return out;
}

export function formatFinalPlanSummary(
  plan: SyncPlan,
  decided: { path: string; shape: ConflictShape; decision: ConflictDecision }[],
  options?: { passthroughOverwrites?: string[] }
): string {
  const decisions = decided.map((d) => d.decision);
  const decisionByPath = new Map(decided.map((d) => [d.path, d]));
  const conflicts = plan.actions
    .filter((a): a is Extract<typeof a, { kind: "conflict" }> => a.kind === "conflict")
    .map((a) => a.path);
  const uploads = plan.actions.filter((a) => a.kind === "local-modified" || a.kind === "local-only");
  const downloads = plan.actions.filter((a) => a.kind === "remote-modified" || a.kind === "remote-only");
  const deletesLocal = plan.actions.filter((a) => a.kind === "remote-deleted");
  const deletesRemote = plan.actions.filter((a) => a.kind === "local-deleted");

  const lines: string[] = [`云同步计划（分支 ${plan.branch}）`];
  lines.push(`  下载：${downloads.length}${downloads.length ? `（${downloads.map((a) => a.path).join("、")}）` : ""}`);
  lines.push(`  上传：${uploads.length}${uploads.length ? `（${uploads.map((a) => a.path).join("、")}）` : ""}`);
  lines.push(
    `  删除：${deletesLocal.length + deletesRemote.length}${
      deletesLocal.length + deletesRemote.length
        ? `（云端删：${deletesLocal.map((a) => a.path).join("、") || "无"}；本机删：${
            deletesRemote.map((a) => a.path).join("、") || "无"
          }）`
        : ""
    }`
  );
  if (conflicts.length > 0) {
    lines.push(`  冲突决策：${conflicts.length}`);
    for (const path of conflicts) {
      const entry = decisionByPath.get(path);
      if (!entry) {
        lines.push(`    - ${path}：⚠️ 尚未决策（不应出现）`);
        continue;
      }
      lines.push(
        `    - ${path}：${decisionSummary(entry.shape, entry.decision.choice, entry.decision.importName)}`
      );
    }
  }
  const imports = decisions.filter((d) => d.importName);
  if (imports.length > 0) {
    lines.push(`  新团队导入：${imports.map((d) => `${d.importName}（来自 ${d.path}）`).join("、")}`);
  }
  // 非团队文件会被云端覆盖（含未跟踪但同名者）——覆盖前留档，清单里如实列出
  const nonTeamOverwrites = [
    ...new Set([...(options?.passthroughOverwrites ?? []), ...plan.ignored.nonYamlLocalModified]),
  ].sort();
  if (nonTeamOverwrites.length > 0) {
    lines.push(`  非团队文件（云端为准，将覆盖本机版本并留档）：${nonTeamOverwrites.join("、")}`);
  }
  // 归档目录与 apply.ts 的 syncConflictsDir 同规则（本模块不依赖 apply，避免循环引用）
  lines.push(`  被放弃的一侧留档到：${join("<dataDir>", "sync-conflicts")}`);
  return lines.join("\n");
}

/** 计划中需要决策的冲突路径（调用点便捷封装）。 */
export function conflictPathsOf(plan: SyncPlan): string[] {
  return listConflicts(plan).map((c) => c.path);
}
