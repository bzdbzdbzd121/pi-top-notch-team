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
requireMatch("AGENTS load-time tool entry", agents, /load-time `start_team_session`/);
requireMatch("README load-time tool entry", readme, /load-time `start_team_session`/);
requireMatch("AGENTS TL tools scoped title", agents, /## TL Tools \(session-scoped registration \+ activation; exception below\)/);
requireMatch("ADR-0003 fresh registry qualification", adrAgentSessions, /A fresh pi process starts with no session-scoped team tools in its registry/);
requireMatch("ADR-0003 activeTools qualification", adrAgentSessions, /remain in the registry after teardown[\s\S]{0,180}removes them from `activeTools` outside a session/);
requireMatch("fully-settled wording", source, /一次运行完全结算/);
requireMatch("fully-settled wording in design", design, /Goal Reminder Lifecycle/i);

if (failures.length > 0) {
  console.error("Goal reminder static check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Goal reminder static check passed (role guard, settled boundary, cooldown, marker ACK, and legacy wording).");
}
