import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const failures = [];

function requireMatch(label, text, pattern) {
  if (!pattern.test(text)) failures.push(`${label}: expected ${pattern}`);
}

function forbidMatch(label, text, pattern) {
  if (pattern.test(text)) failures.push(`${label}: forbidden ${pattern}`);
}

const source = read("src/tools/goal-tools.ts");
const index = read("index.ts");
const agents = read("AGENTS.md");
const design = read("DESIGN.md");
const readme = read("README.md");
const context = read("CONTEXT.md");
const adrAgentSessions = read("docs/adr/0003-agent-initiated-team-sessions.md");
const sessionToolVisibility = read("src/session/session-tool-visibility.ts");
const sharedContextTool = read("src/tools/shared-context-tool.ts");
const indexTests = read("src/index.test.ts");
const goalClosingProtocol = read("src/prompts/goal-closing-protocol.ts");
const dynamicMode = read("src/prompts/dynamic-mode.ts");
const agentInitiatedMode = read("src/prompts/agent-initiated-mode.ts");
const lifecycleDocs = [agents, design, readme, context, adrAgentSessions].join("\n");

// Goal reminders use the ordinary sendUserMessage path. Member-channel
// follow-up delivery is intentionally outside this scan.
forbidMatch("goal-tools send options", source, /deliverAs\s*:/);
forbidMatch("goal-tools follow-up option", source, /streamingBehavior\s*:\s*["']followUp["']/);
requireMatch("first-user guard", source, /role\?\s*:\s*unknown\s*\}\)\.role\s*!==\s*["']user["']/);
requireMatch("first-user guard state", source, /run\.sawUserPrompt/);
requireMatch("settled delivery boundary", source, /agent_settled is the only reminder delivery boundary/);
requireMatch("API-only cooldown", source, /lastReminder[\s\S]{0,180}at:\s*now/);
requireMatch("marker correlation", source, /before_agent_start is the first lifecycle event carrying the prompt/);
requireMatch("single handler registration", index, /registerGoalAgentHandler\(pi\);/);
if ((index.match(/registerGoalAgentHandler\(pi\);/g) ?? []).length !== 1) {
  failures.push("index.ts: registerGoalAgentHandler must be registered exactly once");
}
const statusHandlerIndex = index.indexOf("agent_settled: detect Escape-interrupt");
const goalRegistrationIndex = index.indexOf("registerGoalAgentHandler(pi);");
if (statusHandlerIndex < 0 || goalRegistrationIndex < statusHandlerIndex) {
  failures.push("index.ts: goal lifecycle handler must register after the shared agent_settled status handler");
}

// Active documentation must not reintroduce old lifecycle wording.
forbidMatch("legacy stop wording", lifecycleDocs, /在你停止时提醒|目标达成前停下时系统会自动重新触发/);
forbidMatch("auto-compact-owned batch budget", lifecycleDocs, /自动压缩[^\n]*可配置[^\n]*批预算/);
forbidMatch("stale team subcommand count", lifecycleDocs, /11 subcommands|11\+ 个子命令|11 个子命令/i);
forbidMatch("stale command diagram count", lifecycleDocs, /\(8 total\)/i);
forbidMatch("missing autonomous session entry point", design, /waits for `\/team start` or `\/team dynamic` to activate session tools/);
forbidMatch("stale TL tool count", lifecycleDocs, /10 个 TL 工具/);
forbidMatch("stale TL tools scope title", agents, /TL Tools\s*\(registered\s*\+\s*active only during team session\)/i);
forbidMatch("stale session tool registration wording", lifecycleDocs, /仅在团队会话期间注册\+激活|仅在会话期间注册\+激活|仅在会话期间注册\+可见/);
forbidMatch("registry disappearance wording", lifecycleDocs, /会话之外，这些工具不存在于工具注册表中/);
forbidMatch("registry disappearance wording", lifecycleDocs, /Not registered and not available outside a Team Session/);
forbidMatch("registry disappearance wording", lifecycleDocs, /Outside a session the tool registry contains none of them\./);
forbidMatch("registry disappearance wording", lifecycleDocs, /They are \*\*not\*\* available outside a team session\./);
forbidMatch("registry disappearance wording", lifecycleDocs, /会话外工具注册表与活跃集均不含任何团队工具/);
forbidMatch("ADR-0003 stale registry invariant", adrAgentSessions, /outside a session, zero team tools in registry and active set/i);
forbidMatch("index registry disappearance wording", index, /outside a session the tool[\s\S]{0,40}registry contains none of them\./i);
forbidMatch("visibility registry disappearance wording", sessionToolVisibility, /outside a session the tool[\s\S]{0,40}registry contains none of them\./i);
forbidMatch("shared-context registry disappearance wording", sharedContextTool, /Outside a team session[\s\S]{0,50}it does not exist in the tool registry at all\./i);
forbidMatch("README registration-only wording", readme, /这些工具仅在团队会话活跃期间注册并可用。/);
forbidMatch("README mixed-scope registration wording", readme, /这些工具在 fresh pi 进程中尚未注册；首次启动团队会话时按需注册。/);
forbidMatch("fresh-load test scope wording", indexTests, /must NOT[\s\S]{0,100}exist in the tool registry outside a team session/i);
forbidMatch("agent teardown directory cleanup wording", lifecycleDocs, /widgets off,\s*dir cleanup/);
forbidMatch("session-ended banner omission wording", lifecycleDocs, /When `\/team stop` ends the session, `session\.active` becomes `false` and no extra prompt is injected\./);
requireMatch("AGENTS #21 fresh registry qualification", agents, /fresh pi 初始 registry 为空/);
requireMatch("AGENTS #21 existing registry qualification", agents, /已有进程[\s\S]{0,80}registry 仍保留[\s\S]{0,80}activeTools/);
requireMatch("DESIGN §6 registry/activeTools distinction", design, /remain in the registry after teardown[\s\S]{0,120}removed from `activeTools`/);
requireMatch("DESIGN §18 resumable teardown", design, /preserve resumable[\s\S]{0,80}disk cleanup via \/team delete/);
requireMatch("DESIGN session-ended banner", design, /no regular TL instructions[\s\S]{0,180}one-shot session-ended banner may be injected on the next turn/);
requireMatch("AGENTS current team subcommand count", agents, /14 subcommands/);
requireMatch("README current team subcommand count", readme, /\/team 命令（14 个子命令/);
requireMatch("DESIGN current team subcommand count", design, /14 subcommands/);
requireMatch("DESIGN autonomous session entry point", design, /waits for `\/team start`, `\/team dynamic`, or `start_team_session` to activate session tools/);
for (const adrFile of [
  "0001-members-as-independent-pi-rpc-processes.md",
  "0002-tl-as-central-message-router.md",
  "0003-agent-initiated-team-sessions.md",
  "0004-team-session-resume.md",
  "0005-pi-upstream-truncation-marking.md",
  "0006-pi-upstream-abort-compaction-rpc.md",
  "0007-pi-upstream-context-usage-reason.md",
]) {
  requireMatch(`DESIGN ADR layout includes ${adrFile}`, design, new RegExp(adrFile.replaceAll(".", "\\.")));
}
requireMatch("AGENTS load-time tool entry", agents, /load-time `start_team_session`/);
requireMatch("README load-time tool entry", readme, /load-time `start_team_session`/);
requireMatch("README session/dynamic tool scope", readme, /上述 9 个 session-scoped tools[\s\S]{0,220}`add_dynamic_member`[\s\S]{0,120}dynamic mode/);
requireMatch("AGENTS TL tools scoped title", agents, /## TL Tools \(session-scoped registration \+ activation; exception below\)/);
requireMatch("ADR-0003 fresh registry qualification", adrAgentSessions, /A fresh pi process starts with no session-scoped team tools in its registry/);
requireMatch("ADR-0003 activeTools qualification", adrAgentSessions, /remain in the registry after teardown[\s\S]{0,180}removes them from `activeTools` outside a session/);
requireMatch("fully-settled wording", source, /一次运行完全结算/);
requireMatch("fully-settled wording in design", design, /Goal Reminder Lifecycle/i);

// Reminder text presents a concise four-way decision without claiming the
// actual work is unfinished: the goal is only "still active / not yet closed".
requireMatch("reminder goal-still-active wording", source, /仍处于激活状态（尚未调用 \\\`finish_goal\\\`）/);
requireMatch("reminder concise decision prompt", source, /\*\*执行下列唯一匹配的分支\*\*：/);
requireMatch("reminder finish branch first", source, /1\. \*\*如果全部完成条件已满足\*\* — 调用 \\\`finish_goal\\\` 关闭目标，不要再派发任务/);
requireMatch("reminder blocker branch second", source, /2\. \*\*如果遇到不可解决的阻塞问题\*\* — 调用 \\\`finish_goal\\\`/);
forbidMatch("reminder verbose acceptance explanation", source, /不代表验收未完成/);
forbidMatch("reminder verbose verbal-only warning", source, /不得只用文字宣称目标已完成或已阻塞/);
forbidMatch("reminder verbose next-action wording", source, /你的下一个动作必须立即/);
requireMatch("reminder continue branch gated", source, /4\. \*\*仅当确有未满足的完成条件且可以继续推进时\*\*/);
requireMatch("reminder ask-user branch", source, /3\. \*\*如果需要用户提供关键信息或做决策才能继续\*\*[\s\S]{0,80}不要调用 \\\`finish_goal\\\`/);
forbidMatch("reminder legacy unfinished claim", source, /尚未完成。\n/);
requireMatch("finish_goal distinct snippet", source, /Finish the active goal — call when all criteria met or an unresolvable blocker/);
requireMatch("finish_goal do-not-call guideline", source, /Do NOT call finish_goal when completion criteria remain unmet/);
requireMatch("finish_goal no verbal-only closure", source, /Merely claiming in text[\s\S]{0,120}real finish_goal call/);
requireMatch("lifecycle notice finish_goal directive", source, /完成目标后请调用 finish_goal 工具/);
requireMatch("lifecycle notice goal-active wording", source, /Goal 仍处于激活状态（尚未关闭）/);

// All three TL prompt variants must carry the shared mandatory closing
// protocol (defined once in goal-closing-protocol.ts, imported everywhere).
requireMatch("closing protocol shared text", goalClosingProtocol, /finish_goal[\s\S]{0,60}禁止仅口头宣称完成[\s\S]{0,60}只认真实的 finish_goal 调用/);
requireMatch("pre-defined prompt imports closing protocol", index, /GOAL_CLOSING_PROTOCOL_PROMPT/);
requireMatch("dynamic mode imports closing protocol", dynamicMode, /GOAL_CLOSING_PROTOCOL_PROMPT/);
requireMatch("agent-initiated imports closing protocol", agentInitiatedMode, /GOAL_CLOSING_PROTOCOL_PROMPT/);
requireMatch("dynamic mode lists goal tools", dynamicMode, /set_goal\(text, criteria\) \/ finish_goal\(\)/);

// Closing order is verify → finish_goal → final report in all three prompt
// variants (weak models may end the turn right after reporting).
requireMatch("pre-defined closing order", index, /10\. \$\{GOAL_CLOSING_PROTOCOL_PROMPT\}[\s\S]{0,120}11\. 向用户汇报最终结果/);
requireMatch("dynamic closing order", dynamicMode, /8\. \$\{GOAL_CLOSING_PROTOCOL_PROMPT\}[\s\S]{0,120}9\. 向用户汇报最终结果/);
requireMatch("agent-initiated closing order", agentInitiatedMode, /2\. \$\{GOAL_CLOSING_PROTOCOL_PROMPT\}[\s\S]{0,120}3\. 向用户汇报最终结果/);

if (failures.length > 0) {
  console.error("Goal reminder static check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Goal reminder static check passed (role guard, settled boundary, cooldown, marker ACK, and legacy wording).");
}
