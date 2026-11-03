/**
 * Shared "first action protocol" prompt snippet for TL sessions.
 *
 * Injected at the TOP of both the pre-defined team prompt (index.ts) and the
 * dynamic-mode execution phase prompt (dynamic-mode.ts). Rationale: the
 * detailed "铁律" section alone was buried mid-prompt and got diluted by the
 * base coding-assistant system prompt; a short hard rule placed first gives
 * the model an unambiguous initial action for task-type requests.
 *
 * The rule is ONE ordered chain: write_shared_context → start_member →
 * team_send_and_wait. The previous version stated two different "your first
 * tool call must be…" rules in the same list and never mentioned start_member,
 * while /team start does not launch members — so a literal dispatch hit
 * "目标成员不存在或未启动" and the model learned the protocol was wrong. The
 * session-entry reminder points at this chain, so it has to be executable.
 *
 * Keep this snippet short — it previews the detailed rules that follow later
 * in the prompt, it does not replace them. Paired with the runtime soft
 * correction in src/session/tl-read-guard.ts (mentioned in the text so the
 * model knows the rule is enforced, not just advisory).
 */
export const FIRST_ACTION_PROTOCOL_PROMPT = `### 🚨 最高优先级：第一动作协议

收到任何**任务型诉求**（分析、排查、修改、重构、审查、实现等）时，按下面的顺序做，不要在派发前自己动手：

1. **还没写共享上下文** → 你的第一个工具调用就是 \`write_shared_context\`（未写入前 \`start_member\` 会被系统拦截）。
2. **需要的成员还没启动** → 用 \`start_member\` 启动它们。
3. **派发任务** → 用 \`team_send_and_wait\` 把任务派给 Member，其余动作都在这之后；互相独立的任务可以一次派多个。

派发之前**禁止 read / bash 代码文件**——一旦你开始自己读代码，角色就已经偏了。

> 唯一例外：需求对齐阶段为确认某个具体事实，允许读取 1-2 个文件；完整的分析、排查、代码理解一律分派给 Member。

系统带有运行时检测：未派发任务就连续调用工具（read/bash/搜索等）超过 3 次时，所有非管理工具会被**持续拦截**，直到你调用 \`team_send_and_wait\` 派发任务为止。
`;
