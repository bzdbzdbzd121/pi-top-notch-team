import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRootDir } from "../config";
import type { TeamDefinition } from "../team/definition";

/**
 * Shared context file helpers.
 *
 * The .shared-context.md file is the team's shared whiteboard: project
 * background, workflow, collaboration rules, glossary. Historically the
 * system relied on the TL (an LLM) to write it BEFORE calling start_member,
 * and only warned when it was missing ("Shared context file not found").
 * LLMs do not reliably follow that ordering, so the system now guarantees
 * the file exists: ensureSharedContextFile() creates a minimal stub when
 * the TL hasn't written one yet. The TL can overwrite it at any time.
 */

/** Compute the shared context file path for a session. */
export function getSharedContextPath(
  teamName: string,
  sessionId: string | null
): string {
  const sessionSubDir = sessionId ? join(teamName, sessionId) : teamName;
  return join(getRootDir(), "sessions", sessionSubDir, ".shared-context.md");
}

/** Minimal stub content used until the TL writes the real shared context. */
function buildStubContent(team: TeamDefinition): string {
  const memberLines =
    team.members.length > 0
      ? team.members.map((m) => `- ${m.name}（${m.label ?? m.name}）`).join("\n")
      : "（暂无成员）";

  return `# Shared Context — ${team.name}

> ⚠️ 此文件由系统自动创建：TL 尚未写入共享上下文。
> TL 应尽快用 write_shared_context 工具覆盖本文件，补充：项目背景与目标、工作流、协作规则、术语表与关键决策。
> 注意：未调用 write_shared_context 之前，start_member 会被系统拦截。

## 团队
- 名称：${team.name}
- 描述：${team.description ?? ""}

## 成员
${memberLines}

## 项目背景与目标
（待 TL 补充）

## 工作流
（待 TL 补充）

## 协作规则
（待 TL 补充）

## 术语表与关键决策
（待 TL 补充）
`;
}

/**
 * Ensure the shared context file exists; create a minimal stub if missing.
 * Never overwrites an existing file. Returns the file path.
 * Fail-open: fs errors are swallowed (member starts without shared context).
 */
export function ensureSharedContextFile(
  team: TeamDefinition,
  sessionId: string | null
): string {
  const path = getSharedContextPath(team.name, sessionId);
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buildStubContent(team), "utf-8");
    } catch {
      // fail-open — the member will start without a shared context file
    }
  }
  return path;
}

/**
 * Outcome of the post-rename stub rewrite (the caller reports it honestly).
 * - rewritten: the system stub was replaced with the new-name stub
 * - not-stub:  the content is NOT the system stub (do not touch it)
 * - missing:   no shared context file at the (new) session path
 * - undecidable: the file could not be read, so nothing can be claimed
 * - write-failed: recognized as the stub, but the write failed
 */
export type StubRewriteOutcome =
  | "rewritten"
  | "not-stub"
  | "missing"
  | "undecidable"
  | "write-failed"
  /** Idempotent rename (same name): the stub was not inspected nor touched. */
  | "not-attempted";

/**
 * Is `content` still the system-generated stub for `team`?
 *
 * STRUCTURAL comparison, not a byte comparison against the current team state:
 * the stub is written at bootstrap with 0 members, and `add_dynamic_member`
 * later grows the roster without rewriting it — so the member block is allowed
 * to differ (only its shape is validated). Everything else (header with the
 * old name, the auto-created warning, description line, placeholder sections)
 * must still match byte-for-byte. `team` must carry the OLD team name.
 */
export function isSystemStub(content: string, team: TeamDefinition): boolean {
  function splitRoster(lines: string[]): { head: string[]; roster: string[]; tail: string[] } | null {
    const start = lines.indexOf("## 成员");
    const end = lines.indexOf("## 项目背景与目标");
    if (start < 0 || end <= start) return null;
    return {
      head: lines.slice(0, start + 1),
      roster: lines.slice(start + 1, end),
      tail: lines.slice(end),
    };
  }

  const actual = splitRoster(content.split("\n"));
  const expected = splitRoster(buildStubContent(team).split("\n"));
  if (!actual || !expected) return false;
  if (actual.head.join("\n") !== expected.head.join("\n")) return false;
  if (actual.tail.join("\n") !== expected.tail.join("\n")) return false;

  // The roster block is the only mutable part: accept the empty marker or the
  // `- name（label）` lines the generator emits. A TL-written file that kept
  // every fixed section but injected arbitrary lines here is rejected.
  const roster = actual.roster.filter((line) => line.trim() !== "");
  if (roster.length === 0) return false;
  if (roster.length === 1 && roster[0] === "（暂无成员）") return true;
  return roster.every((line) => /^- .+（.+）$/.test(line));
}

/**
 * Rewrite the system stub after a team rename. The caller has already moved
 * the session directory, so the file is read at the NEW path.
 * A TL-written (or otherwise modified) shared context is never touched.
 */
export function rewriteStubIfUnchanged(
  oldTeam: TeamDefinition,
  newTeam: TeamDefinition,
  sessionId: string | null
): StubRewriteOutcome {
  const path = getSharedContextPath(newTeam.name, sessionId);
  let content: string;
  try {
    if (!existsSync(path)) return "missing";
    content = readFileSync(path, "utf-8");
  } catch {
    // Unreadable (permissions, a directory in place of the file, I/O error):
    // do not guess — the caller must report "cannot tell".
    return "undecidable";
  }
  if (!isSystemStub(content, oldTeam)) return "not-stub";
  try {
    writeFileSync(path, buildStubContent(newTeam), "utf-8");
    return "rewritten";
  } catch {
    return "write-failed";
  }
}
