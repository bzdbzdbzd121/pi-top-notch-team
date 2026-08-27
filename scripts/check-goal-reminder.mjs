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
const lifecycleDocs = ["AGENTS.md", "DESIGN.md", "README.md", "CONTEXT.md"].map(read).join("\n");

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
forbidMatch("registry disappearance wording", lifecycleDocs, /会话之外，这些工具不存在于工具注册表中/);
forbidMatch("registry disappearance wording", lifecycleDocs, /Not registered and not available outside a Team Session/);
forbidMatch("registry disappearance wording", lifecycleDocs, /Outside a session the tool registry contains none of them\./);
requireMatch("fully-settled wording", source, /一次运行完全结算/);
requireMatch("fully-settled wording in design", read("DESIGN.md"), /Goal Reminder Lifecycle/i);

if (failures.length > 0) {
  console.error("Goal reminder static check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Goal reminder static check passed (role guard, settled boundary, cooldown, marker ACK, and legacy wording).");
}
