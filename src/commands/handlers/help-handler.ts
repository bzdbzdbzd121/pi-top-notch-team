import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const USAGE_TEXT = [
  `用法：/team <子命令> [参数]`,
  `  /team create           创建团队（自然语言对话）`,
  `  /team dynamic          动态团队模式（TL 自动设计团队）`,
  `  /team edit <名称>       修改团队定义（自然语言对话）`,
  `  /team done             完成并退出编辑/创建模式`,
  `  /team cancel           取消当前的创建或编辑操作（同 /team done）`,
  `  /team start <名称>      启动团队会话`,
  `  /team stop             终止团队会话`,
  `  /team list             列出所有已创建的团队`,
  `  /team show <名称>       显示团队定义详情`,
  `  /team delete <名称>     删除团队定义`,
  `  /team status           查看当前团队会话状态`,
  `  /team help             显示此帮助信息`,
].join("\n");

/**
 * /team help — Display usage information.
 * Also used as fallback for unknown subcommands (shown as warning).
 */
export async function handleHelp(
  ctx: ExtensionCommandContext,
  subcommand: string,
): Promise<void> {
  ctx.ui.notify(USAGE_TEXT, subcommand === "help" ? "info" : "warning");
}
