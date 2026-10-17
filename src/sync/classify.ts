/**
 * 三方比较与冲突真值表（方案 §7.C，纯函数，零 IO）。
 *
 * 判定依据是三个版本：基准 B（本机与云端上一次一致时的共同版本）、
 * 本机版本 L、云端版本 R。「内容相同」用**内容令牌**的相等性判断——
 * 生产代码传入 git blob id（经仓库/全局属性与换行过滤，§7.C 补充规则），
 * 这样「比较结果」与「实际提交的内容」永远一致；本机尚无 git 仓库时
 * 传字节内容令牌即可（首次接入前不涉及过滤规则）。
 *
 * 本模块不做任何 IO、不读文件、不调用 git：分类是决策核心，必须可被
 * 表驱动单测完整覆盖（§7.G 纯函数单测层）。
 */

/**
 * 某一侧的内容令牌；`null` 表示该侧不存在（未跟踪 / 已删除）。
 * 相同令牌 = 内容相同（git 语义：blob id），不同令牌 = 内容不同。
 */
export type VersionRef = string | null;

/** 单个团队文件的三方版本（path 为 teams/ 下的相对路径）。 */
export interface FileVersions {
  path: string;
  base: VersionRef;
  local: VersionRef;
  remote: VersionRef;
}

/** 冲突可选项（方案 §3.4 / §6.3 第 2 项）。 */
export type ConflictOption = "keep-local" | "take-remote" | "keep-both";

/** §7.C 真值表的分类结果（动作由调用方按 kind 派生，本模块不编码动作）。 */
export type FileClass =
  | { kind: "unchanged"; path: string }
  | { kind: "local-only"; path: string }
  | { kind: "remote-only"; path: string }
  | { kind: "local-modified"; path: string }
  | { kind: "remote-modified"; path: string }
  | { kind: "local-deleted"; path: string }
  | { kind: "remote-deleted"; path: string }
  | { kind: "both-deleted"; path: string }
  | { kind: "conflict"; path: string; options: ConflictOption[] };

export type FileClassKind = FileClass["kind"];

/** 三选项冲突（两边都改 / add-add）：保留本地 / 采用远端 / 两边都留。 */
const THREE_OPTIONS: ConflictOption[] = ["keep-local", "take-remote", "keep-both"];

/**
 * 分类单个路径（§7.C 逐行实现；注释里的 #n 与真值表行号一一对应）。
 *
 * 判定顺序刻意与真值表一致，便于对照审查与增补：
 * 1. 先判「两边内容相同」——它同时覆盖 #1（三方相同）与 #4（两边新增且相同）。
 * 2. 基准缺失时只剩 #5 / #12 / #13。
 * 3. 基准存在时按「哪一侧与基准相同」区分「仅本机改/删」与「冲突」。
 */
export function classifyFile(versions: FileVersions): FileClass {
  const { path } = versions;
  const hasBase = versions.base !== null;
  const hasLocal = versions.local !== null;
  const hasRemote = versions.remote !== null;

  // #1 三方相同；#4 两边新增且内容相同（含两边都改成同一新内容）→ 无变化
  if (hasLocal && hasRemote && versions.local === versions.remote) {
    return { kind: "unchanged", path };
  }

  if (!hasBase) {
    if (hasLocal && hasRemote) {
      // #5 两边新增同名不同内容（add/add）→ 冲突，三选项
      return { kind: "conflict", path, options: [...THREE_OPTIONS] };
    }
    if (hasLocal) {
      // #12 仅本机新增 → 上传
      return { kind: "local-only", path };
    }
    if (hasRemote) {
      // #13 仅云端新增 → 下载
      return { kind: "remote-only", path };
    }
    // 三处皆无内容：调用方应由 B/L/R 的并集枚举路径，正常不会出现。
    // 按「无动作」兜底（fail-safe：绝不因枚举异常而误删/误写）。
    return { kind: "unchanged", path };
  }

  // 基准存在，且两边内容不同（相同已在上面返回）
  if (hasLocal && hasRemote) {
    if (versions.local === versions.base) {
      // #3 仅云端改 → 下载
      return { kind: "remote-modified", path };
    }
    if (versions.remote === versions.base) {
      // #2 仅本机改 → 上传
      return { kind: "local-modified", path };
    }
    // #6 两边都改 → 冲突，三选项
    return { kind: "conflict", path, options: [...THREE_OPTIONS] };
  }

  if (!hasLocal && hasRemote) {
    if (versions.remote === versions.base) {
      // #9 仅本机删 → 云端删除
      return { kind: "local-deleted", path };
    }
    // #7 本机删 + 云端改（delete/modify）→ 恢复云端 / 保持删除
    return { kind: "conflict", path, options: ["take-remote", "keep-local"] };
  }

  if (hasLocal && !hasRemote) {
    if (versions.local === versions.base) {
      // #10 仅云端删 → 本机删除
      return { kind: "remote-deleted", path };
    }
    // #8 本机改 + 云端删（modify/delete）→ 保留本机（重新上传）/ 接受删除
    return { kind: "conflict", path, options: ["keep-local", "take-remote"] };
  }

  // #11 两边都删 → 提交树中删除（无提示）
  return { kind: "both-deleted", path };
}

/** 批量分类（保持输入顺序）。 */
export function classifyFiles(files: FileVersions[]): FileClass[] {
  return files.map(classifyFile);
}
