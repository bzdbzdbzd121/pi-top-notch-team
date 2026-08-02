import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
