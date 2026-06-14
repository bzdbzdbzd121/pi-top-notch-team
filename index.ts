import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./src/commands/team";
import { TeamModeEditor } from "./src/ui/team-mode-editor";
import { getSessionState, endSession } from "./src/session/state";
import type { TeamContext } from "./src/session/context";
import { getRootDir } from "./src/config";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { registerTlTools } from "./src/tools/tl-tools";
import { createProcessManager } from "./src/process/manager";
import { createTeamStatusWidget } from "./src/ui/team-status-widget";
import {
  createAndRegisterMember,
  buildMemberConfig,
  getMemberLog,
} from "./src/setup/member-lifecycle";
import { createMessageChannel } from "./src/setup/message-channel";
import { buildDynamicModePrompt } from "./src/prompts/dynamic-mode";

export default function (pi: ExtensionAPI) {
  // If running as a member process (TEAM_ROLE is set), skip TL-only tools
  // to avoid tool name conflicts with member.ts.
  if (process.env.TEAM_ROLE) {
    return;
  }

  // ── Team mode editor (border color change) ────────────────
  let teamModeEditorInstance: TeamModeEditor | null = null;
  let sessionUiRef: any = null;

  // ── Shared mutable state ──────────────────────────────────
  const teamCtx: TeamContext = {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    processManager: null,
    memberHandles: new Map(),
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait", "get_member_status"],
    router: null,
    messageQueue: null,
    responseWaiter: null,
    memberOperationalStates: null,
  };

  // ── Manager (includes unified operational state) ────────────
  const manager = createProcessManager([], {
    autoRestart: false,
    onCrashLoopDetected: (name, restarts) => {
      pi.sendMessage({
          customType: "team-message",
          content: `Member "${name}" 已连续崩溃 ${restarts} 次，已停止自动重启。`,
          display: true,
        });
    },
  });
  teamCtx.processManager = manager;

  // Get the unified operational state map from the manager
  const memberOpsStates = manager.getOperationalStateMap();

  // Track the most recent correlation ID sent to each member via team_send_and_wait.
  // Used to auto-inject correlation ID when a member replies without the <corr:...> tag.
  const lastPendingCorrId = new Map<string, string>();
  // Track recently processed tool_execution_end message fingerprints for de-duplication
  const recentlyProcessedMessages = new Map<string, number>();

  // waitWithAllIdleCheck is defined in src/tools/tl-tools.ts

  // ── Message channel: queue → router (extracted to src/setup/message-channel.ts) ──
  const { router, messageQueue, responseWaiter } = createMessageChannel({
    pi,
    memberOpsStates,
    lastPendingCorrId,
    memberHandles: teamCtx.memberHandles,
  });

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;
  teamCtx.responseWaiter = responseWaiter;
  teamCtx.memberOperationalStates = memberOpsStates;

  // (delegated to src/setup/member-lifecycle.ts via registerTlTools below)

  const memberLifecycleDeps = {
    pi,
    memberOpsStates,
    messageQueue,
    responseWaiter,
    lastPendingCorrId,
    recentlyProcessedMessages,
    processManager: manager,
  };

  registerTlTools({
    pi,
    manager,
    responseWaiter,
    memberOpsStates,
    lastPendingCorrId,
    messageQueue,
    createMember: (config) => {
      const handle = createAndRegisterMember(pi, config, memberLifecycleDeps);
      teamCtx.memberHandles.set(config.name, handle);
      return handle;
    },
    buildMemberConfig: (memberName) => buildMemberConfig(memberName, getSessionState()),
    getMemberLog: async (memberName, maxLines, maxContentLength) => {
      const handle = teamCtx.memberHandles.get(memberName);
      if (!handle) {
        throw new Error(`Member "${memberName}" not found`);
      }
      return getMemberLog(handle, maxLines, maxContentLength);
    },
  });

  // team_send_and_wait and get_member_status are registered in src/tools/tl-tools.ts

  // ── Call-level guard: block code-file writes during team session ───
  pi.on("tool_call", (event) => {
    if (!getSessionState().active) return; // only block during active team session

    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const input = event.input as { path?: string };
    const filePath = input?.path ?? "";

    // Allow .md files (shared context, ADRs, planning docs)
    if (filePath.endsWith(".md")) return;

    // Block everything else (code, config, etc.)
    return {
      block: true,
      reason: `团队会话期间不得使用 ${event.toolName} 写代码文件。请委派给 Member 执行。你可以编写 .md 文档（如 .shared-context.md、ADR 等）。`,
    };
  });

  // ── session_shutdown: clean up team state on /new, /resume, /fork ──
  pi.on("session_shutdown", () => {
    const _session = getSessionState();
    if (_session.active) {
      const dynamicDir = teamCtx.isDynamicSession && _session.teamDefinition
        ? join(getRootDir(), "sessions", _session.teamDefinition.name)
        : null;
      endSession();
      if (teamCtx.onSessionEnd) {
        teamCtx.onSessionEnd();
      }
      // Best-effort cleanup of dynamic session directory
      if (dynamicDir) {
        try { rmSync(dynamicDir, { recursive: true, force: true }); } catch {}
      }
      teamCtx.isDynamicSession = false;
    }
  });

  // ── session_start: reset stale team state when fresh session detected ──
  pi.on("session_start", (_event, ctx) => {
    if (ctx.sessionManager) {
      const entries = ctx.sessionManager.getEntries() ?? [];
      const isFresh = entries.length <= 1;
      if (isFresh && getSessionState().active) {
        const isDynamic = teamCtx.isDynamicSession;
        const dynamicTeamName = getSessionState().teamDefinition?.name;
        const dynamicDir = isDynamic && dynamicTeamName
          ? join(getRootDir(), "sessions", dynamicTeamName)
          : null;
        endSession();
        if (teamCtx.onSessionEnd) {
          teamCtx.onSessionEnd();
        }
        if (dynamicDir) {
          try { rmSync(dynamicDir, { recursive: true, force: true }); } catch {}
        }
        teamCtx.isDynamicSession = false;
      }
    }
  });

  // ── Custom autocomplete: team names for /team start|show|delete|edit ──
  pi.on("session_start", (_event, ctx) => {
    // Store UI ref for session end cleanup
    sessionUiRef = ctx.ui;

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, line, col, options) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        const m = beforeCursor.match(/^\/team\s+(start|show|delete|edit)(\s+)(.*)$/);
        if (m) {
          const subCmd = m[1];     // e.g. "show"
          const spacing = m[2];    // e.g. " "
          const partial = m[3];    // typed team name (or empty)
          const { listTeams } = await import("./src/team/store");
          const { getRootDir } = await import("./src/config");
          const teams = listTeams(getRootDir());
          // Replace everything from subcommand onward: "show " -> "show teamname"
          const prefix = subCmd + spacing + partial;
          const items = teams
            .filter((t: string) => t.startsWith(partial))
            .map((t: string) => ({ value: `${subCmd} ${t}`, label: t }));
          return { prefix, items };
        }
        return current.getSuggestions(lines, line, col, options);
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, col) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        if (/^\/team/.test(beforeCursor)) return false;
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));

    // Register team mode editor factory (border color change)
    ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => {
      teamModeEditorInstance = new TeamModeEditor(tui, theme, kb, ctx.ui.theme);
      if (getSessionState().active) {
        teamModeEditorInstance.setTeamMode(true);
      }
      return teamModeEditorInstance;
    });
  });

  // ── Register the /team command ────────────────────────────
  registerTeamCommand(pi, teamCtx, () =>
    (teamCtx.processManager?.listStatus().map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
    })) ?? [])
  );

  // ── Team status widget (team mode visual indicator) ─────
  let teamStatusWidget: ReturnType<typeof createTeamStatusWidget> | null = null;

  // Wire UI lifecycle hooks so commands/team.ts can install/uninstall immediately
  teamCtx.onSessionStart = (ui) => {
    // If already installed, skip
    if (teamStatusWidget) return;
    const session = getSessionState();
    if (!session.teamDefinition) return;
    teamStatusWidget = createTeamStatusWidget({
      teamName: session.teamDefinition.name,
      getMembers: () => getSessionState().teamDefinition?.members ?? [],
      teamCtx,
      memberOpsStates,
    });
    teamStatusWidget.install(ui, ui.theme);

    // Activate team mode editor border
    if (teamModeEditorInstance) {
      teamModeEditorInstance.setTeamMode(true);
      try { (ui as any).requestRender?.(); } catch {}
    }
  };
  teamCtx.onSessionEnd = () => {
    if (teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
    }

    // Restore default editor border
    if (teamModeEditorInstance) {
      teamModeEditorInstance.setTeamMode(false);
    }
    if (sessionUiRef) {
      sessionUiRef.setEditorComponent(undefined);
    }
  };

  // ── TL system prompt injection ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const session = getSessionState();

    // Safety net: if widget wasn't installed by /team start (e.g., session resume),
    // install it here. Also clean up if session ended without /team stop.
    if (session.active && session.teamDefinition && !teamStatusWidget) {
      teamStatusWidget = createTeamStatusWidget({
        teamName: session.teamDefinition.name,
        getMembers: () => getSessionState().teamDefinition?.members ?? [],
        teamCtx,
        memberOpsStates,
      });
      teamStatusWidget.install(_ctx.ui, _ctx.ui.theme);
    }
    if (!session.active && teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
    }

    let extraPrompt = "";

    if (teamCtx.isCreatingTeam) {
      extraPrompt = `
## 当前任务：创建团队定义

你正在引导用户创建一个新的团队。请通过自然语言对话收集信息。

### 自动推断规则
当用户描述角色时（如"一个worker负责编码"），自动推断：
- **label** = 用户描述中的中文角色名（如"编码员"）
- **name** = label 的英文/拼音标识符（如 \`worker\`），小写字母数字连字符
- **systemPrompt** = 根据用户描述的角色职责展开编写
- **model** = 按需指定，不填则用默认模型

**不要**追问 name 和 label——直接从用户的描述中推断。
除非你无法确定合适的标识符，才向用户确认。

### 收集清单
1. **团队名称和描述** — 由用户自由描述
2. **成员角色** — 用户说出每个角色的职责，你自动生成配置
3. **默认模型** — 按需指定（可选）
4. **默认工作流（可选）** — 成员收集完后，询问用户是否需要定义工作流

### 工作流配置（可选）
成员收集完后，询问用户是否需要定义工作流。如果有 workflow，TL 会按步骤拆解任务。

对话流程：
1. 问用户是否需要工作流
2. 需要则问 strictness（strict = 严格按顺序 / reference = 灵活参考）
3. 逐步骤收集：执行成员（从已定义的成员中选择）、步骤名称、描述、可选输入输出、可失败处理
4. 问是否需要循环段（例如「代码审查不通过时循环修改」）
5. 最后调用 \`create_team_definition\` 时 workflow 一并提交

如果用户说不需要工作流，跳过即可。不要强行推荐。

收集完后向用户展示汇总并确认，然后调用 \`create_team_definition\` 工具保存。
如果用户想取消操作，告诉用户输入 \`/team cancel\`。
`;
    } else if (teamCtx.editingTeamName) {
      const editName = teamCtx.editingTeamName;
      extraPrompt = `
## 当前任务：修改团队定义

你正在协助用户修改团队 **${editName}**。请通过自然语言对话了解用户想做的修改。

可能的修改包括：
- 修改团队名称或描述
- 添加新成员（name/label/systemPrompt/model）
- 修改现有成员（名称、提示词、模型）
- 删除成员
- 修改默认模型
- 添加/修改/删除工作流
- 修改工作流 strictness
- 添加/修改/删除工作流步骤
- 添加/修改/删除循环段

**不要**追问 name 和 label——从用户的描述中推断。

### 关于 update_team_definition 的 merge 机制

调用 \`update_team_definition\` 时注意以下规则以减小 payload：
- **未变更的现有成员** — 只需传 \`{name: "成员名"}\`，不传 systemPrompt。systemPrompt/label/model 自动从磁盘已有配置填充
- **新增或修改的成员** — 传完整数据（name、systemPrompt 等）
- **要删除的成员** — 直接从 members 数组中排除
- **workflow** 和 **defaults** — 如果不变可以不传，自动保留原有值

这样你就不必在 tool call 中重复所有成员的长篇 systemPrompt，避免 payload 过大导致输出截断。

了解清楚所有修改后，向用户展示修改汇总并确认，然后调用 \`update_team_definition\` 工具保存最终定义。
如果用户想取消操作，告诉用户输入 \`/team cancel\`。
`;
    } else if (teamCtx.isDynamicSession && session.teamDefinition) {
      extraPrompt = buildDynamicModePrompt(session.teamDefinition);
    } else if (session.active && session.teamDefinition) {
      const team = session.teamDefinition;
      const memberLines = team.members
        .map((m) => `  - ${m.name}（${m.label ?? m.name}）— ${m.systemPrompt.slice(0, 80)}`)
        .join("\n");

      // Workflow prompt injection
      let workflowText = "";
      if (team.workflow) {
        const wf = team.workflow;
        const fmtStage = (s: (typeof wf.stages)[number]): string => {
          let t = `  【${s.name}】${s.description} (${s.member})`;
          if (s.input) t += `\n    输入：${s.input}`;
          if (s.output) t += `\n    输出：${s.output}`;
          if (s.constraints) t += `\n    约束：${s.constraints}`;
          if (s.onFailure) t += `\n    失败处理：如「${s.onFailure.condition}」→ 回退至「${s.onFailure.returnToStage}」`;
          return t;
        };
        if (wf.strictness === "strict") {
          workflowText += `\n### 默认工作流（严格模式 ⚡）\n严格按照以下步骤执行，不得跳过或调序。\n\n`;
        } else {
          workflowText += `\n### 默认工作流（参考模式 📋）\n作为工作流程参考，尽可能遵循步骤顺序。\n\n`;
        }
        if (wf.description) workflowText += `**描述：** ${wf.description}\n\n`;
        workflowText += `**步骤序列：**\n`;
        for (const s of wf.stages) workflowText += fmtStage(s) + "\n\n";
        if (wf.loops && wf.loops.length > 0) {
          workflowText += `**循环段：**\n`;
          for (const loop of wf.loops) {
            workflowText += `  🔁 条件「${loop.condition}」→ 重复步骤：${loop.stages.join("、")}\n`;
          }
          workflowText += "\n";
        }
        if (wf.strictness === "strict") {
          workflowText += `> 规则：完成上一个 stage 前不得开始下一个。Stage 失败时按 onFailure 策略处理。\n`;
        }
      }

      extraPrompt = `
## 当前任务：Team Lead

你现在是一个 **Team Lead**，负责领导团队完成任务。

### 团队：${team.name}
${team.description}

### 团队成员
${memberLines}
${workflowText}
### 核心原则：委派优先
- **能交给 Member 做的事，绝不自己做。** 你是 Team Lead 不是执行者。
- 需要分析代码？委派给分析员。需要修改文件？委派给开发员。需要验证？委派给测试员。
- 你的职责是：拆解任务、制定计划、分配工作、协调进度、处理异常。
- 只有以下情况才自己动手：涉及团队管理的决策、成员不可用时的紧急处理、向用户汇报结果。
- **你可以编写 .md 文档**（如 .shared-context.md、ADR 等），但**不得使用 write/edit 写代码文件**（.ts/.js/.py/.json 等）——这些工作一律委派给 Member。
- **成员完成任务后不要主动停止其进程。** Member 进程保持运行以便继续接收新任务。仅当成员进程异常时（崩溃、无响应），才使用 stop_member 终止后重新启动。

### 与用户讨论需求的方式

在拆解任务之前，**逐个方面**与用户深入讨论，每次只讨论一个话题，达成共识后再继续下一个。

**期间遵循以下原则：**

- **一次只问一个问题** — 等用户回复后再问下一个。不要一次性抛出多个问题让用户选择。
- **能用代码验证的，不要去问用户** — 如果问题可以通过阅读代码库来回答，先查阅代码再给出结论。
- **挑战模糊语言** — 当用户用词不精确时，提出更精确的术语。例如用户说"优化性能"——追问"你指的是减少响应时间还是降低资源占用？"
- **用场景检验边界** — 提出具体的边界场景来检验需求。例如"如果 A 成员依赖 B 成员的结果，但 B 还没完成怎么办？"
- **对照实际代码** — 当用户描述现有行为时，检查代码是否一致。发现矛盾时指出来让用户确认。
- **术语和决策立即固化** — 讨论中确定的关键术语、决策、约定，立即写入 .shared-context.md 的对应章节，不攒到后面。

.shared-context.md 应作为术语表和关键决策记录，不包含实现细节。当某个决策满足以下三个条件时，考虑创建 ADR 文档（在 docs/adr 目录下）：逆决策成本高、外人看会觉得意外、是经过真正权衡后选择的。

讨论达成共识后，拆解任务并委派给各 Member。**委派时明确要求：需要产出的报告、方案、设计文档直接写入文件，避免成员间通过消息传递大段内容。**

### 沟通风格
- 与用户交流时保持简洁精炼，剔除客套话、语气词、多余铺垫与模棱两可的表述
- 保留完整句式与语法，专业术语原样不变
- 只输出核心内容，全程保持精简风格

### 可用工具
你拥有 7 个团队管理工具：

1. **先写 Shared Context** — 用编辑器的 write 或 edit 工具创建 .shared-context.md
2. **start_member(name)** — 启动一个 Member 进程
3. **team_send_and_wait(to, content?, timeout?, correlationId?)** — 给 Member 发任务并等待回复（阻塞）。超时后如需续等，用相同的 correlationId 重新调用（不发新消息，只续等）
4. **list_members** — 查看各 Member 的运行状态
5. **get_member_status()** — **优先使用**。快速查看所有成员当前操作状态（idle/working/crashed/stopped），负担轻
6. **get_member_log(name, lines?)** — 查看 Member 最近的详细对话记录，负担较重，仅当需要了解具体内容时才使用
7. **stop_member(name)** — 终止 Member 进程

> 提示：team_send_and_wait 发送的消息包含 <corr:...> 标签。其他成员回复时需在内容中包含此标签，这样即使任务经过多次转交（A->B->TL），最终的回复也能正确匹配等待器。消息通道中的 Team Lead 名称是 tl。

### 流程
1. 先与用户充分讨论需求，直到和用户对齐细节
2. 拆解任务，制定计划
3. 编写 Shared Context（共享上下文），记录：团队成员、项目背景和目标、协作规则、术语表
4. 用 start_member 启动各 Member
5. 将 Shared Context 随首次任务消息一起发送给各 Member。**在消息中明确告知 Member 任务完成后必须回复 TL，并指示 Member：输出报告/方案/设计文档时写入文件，不要在消息通道中塞入大量内容。**
6. 通过消息通道与 Member 交流，监控进展（可使用 team_send_and_wait 等待成员回复）
7. 根据需要更新 Shared Context，通知所有 Member 重新阅读
8. 任务完成后向用户汇报结果
9. 让用户决定是否 /team stop
`;
    }

    if (extraPrompt) {
      return { systemPrompt: event.systemPrompt + extraPrompt };
    }
  });
}
