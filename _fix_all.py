content = open("index.ts", "r", encoding="utf-8").read()

# 1. Add imports
content = content.replace(
    "import { createRouter } from \"./src/channel/router\";\n"
    "import type { TeamMessage } from \"./src/channel/types\";",
    "import { createRouter } from \"./src/channel/router\";\n"
    "import { createResponseWaiter, extractCorrelationId } from \"./src/channel/response-waiter\";\n"
    "import type { TeamMessage } from \"./src/channel/types\";"
)

# 2. Add responseWaiter to teamCtx init
content = content.replace(
    "    tlToolNames: [\"start_member\", \"stop_member\", \"list_members\", \"get_member_log\"],\n"
    "    router: null as any,\n"
    "    messageQueue: null as any,",
    "    tlToolNames: [\"start_member\", \"stop_member\", \"list_members\", \"get_member_log\", \"team_send_and_wait\"],\n"
    "    router: null as any,\n"
    "    messageQueue: null as any,\n"
    "    responseWaiter: null as any,"
)

# 3. Add responseWaiter creation after messageQueue
content = content.replace(
    "  });

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;",
    "  });

  const responseWaiter = createResponseWaiter();

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;
  teamCtx.responseWaiter = responseWaiter;"
)

# 4. Update sendToTl to check waiter
content = content.replace(
    "    sendToTl: (msg: TeamMessage) => {\n"
    "      pi.sendMessage({\n"
    '        customType: "team-message",\n'
    "        content: `[消息通道 - 来自 ${msg.from}]\\n${msg.subject ? `主题：${msg.subject}\\n` : \"\"}${msg.content}`,\n"
    "        display: true,\n"
    "        details: { msg },",
    "    sendToTl: (msg: TeamMessage) => {\n"
    "      // Check if there is a pending ResponseWaiter for this message's correlation ID\n"
    "      const corrId =\n"
    "        msg.correlationId ?? extractCorrelationId(msg.content);\n"
    "      if (corrId) {\n"
    "        const resolved = responseWaiter.resolveIfWaiting(\n"
    "          corrId,\n"
    "          msg.from,\n"
    "          msg.content,\n"
    "          msg.subject\n"
    "        );\n"
    "        if (resolved) {\n"
    "          // Message consumed by waiter -- skip pi.sendMessage()\n"
    "          return;\n"
    "        }\n"
    "      }\n\n"
    "      pi.sendMessage({\n"
    '        customType: "team-message",\n'
    "        content: `[消息通道 - 来自 ${msg.from}]\\n${msg.subject ? `主题：${msg.subject}\\n` : \"\"}${msg.content}`,\n"
    "        display: true,\n"
    "        details: { msg },"
)

# 5. Add team_send_and_wait tool after registerTlTools call
content = content.replace(
    "  });\n\n  // ── Custom autocomplete",
    "  });\n\n"
    "  // ── team_send_and_wait tool ───────────────────────────────\n"
    "  pi.registerTool({\n"
    '    name: "team_send_and_wait",\n'
    '    label: "Send Message and Wait",\n'
    "    description:\n"
    '      "Send a message to a team member and WAIT for their response before continuing. " +\n'
    '      "Use this instead of team_send_message when you need the member\'s processing result. " +\n'
    '      "Parameters: to (target member name), content (message body), timeout (optional, max wait in ms, default 120000).",\n'
    "    promptGuidelines: [\n"
    '      "Use team_send_and_wait when you need a member\'s result before continuing.",\n'
    '      "On timeout (status: timeout), check the member\'s status via get_member_log and re-wait if still working.",\n'
    '      "The member\'s response includes a <corr:...> tag for correlation matching; chain workflows are supported.",\n'
    "    ],\n"
    "    parameters: {\n"
    '      type: "object",\n'
    "      properties: {\n"
    "        to: {\n"
    '          type: "string",\n'
    '          description: "Target member name",\n'
    "        },\n"
    "        content: {\n"
    '          type: "string",\n'
    '          description: "Message body",\n'
    "        },\n"
    "        timeout: {\n"
    '          type: "number",\n'
    '          description: "Max wait time in milliseconds (default: 120000, max: 300000)",\n'
    "        },\n"
    "      },\n"
    '      required: ["to", "content"],\n'
    "    } as any,\n"
    "    async execute(\n"
    '      _toolCallId: string,\n'
    "      params: { to: string; content: string; timeout?: number }\n"
    "    ) {\n"
    "      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;\n"
    "      messageQueue.enqueue({\n"
    "        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,\n"
    '        from: "tl",\n'
    "        to: params.to,\n"
    "        content: params.content + `\\n\\n<corr:${correlationId}>`,\n"
    "        timestamp: Date.now(),\n"
    "        correlationId,\n"
    "      });\n"
    "      const result = await responseWaiter.waitForResponse(\n"
    "        correlationId,\n"
    "        params.timeout ?? 120_000\n"
    "      );\n"
    "      if (result.status === \"response\") {\n"
    "        return {\n"
    "          details: {},\n"
    "          content: [\n"
    "            {\n"
    '              type: "text" as const,\n'
    "              text: `[${params.to} \\u56de\\u590d] ${result.content}`,\n"
    "            },\n"
    "          ],\n"
    "        };\n"
    "      }\n"
    "      if (result.status === \"cancelled\") {\n"
    "        return {\n"
    "          details: {},\n"
    "          content: [\n"
    "            {\n"
    '              type: "text" as const,\n'
    "              text: `\\u7b49\\u5f85 ${params.to} \\u56de\\u590d\\u7684\\u64cd\\u4f5c\\u5df2\\u88ab\\u53d6\\u6d88\\u3002`,\n"
    "            },\n"
    "          ],\n"
    "        };\n"
    "      }\n"
    "      return {\n"
    "        details: { timeout: true, memberName: params.to, correlationId },\n"
    "        content: [\n"
    "          {\n"
    '            type: "text" as const,\n'
    "            text: `\\u7b49\\u5f85 ${params.to} \\u56de\\u590d\\u8d85\\u65f6\\uff08${(params.timeout ?? 120_000) / 1000}s\\uff09\\u3002\\u8bf7\\u4f7f\\u7528 get_member_log \\u68c0\\u67e5\\u6210\\u5458\\u72b6\\u6001\\uff0c\\u5982\\u4ecd\\u5728\\u5de5\\u4f5c\\u4e2d\\u53ef\\u518d\\u6b21\\u8c03\\u7528 team_send_and_wait \\u7eed\\u7b49\\u3002`,\n"
    "          },\n"
    "        ],\n"
    "      };\n"
    "    },\n"
    "  });\n\n  // ── Custom autocomplete"
)

# 6. Update the TL system prompt tools section (no backticks in template literal!)
old_prompt = (
    "### \\u53ef\\u7528\\u5de5\\u5177\\n"
    "\\u4f60\\u62e5\\u6709 4 \\u4e2a\\u56e2\\u961f\\u7ba1\\u7406\\u5de5\\u5177\\u3002\\u4f7f\\u7528\\u6b65\\u9aa4\\uff1a\\n\\n"
    "1. **\\u5148\\u5199 Shared Context** \\u2014 \\u7528\\u7f16\\u8f91\\u5668\\u7684 write \\u6216 edit \\u5de5\\u5177\\u521b\\u5efa shared-context.md\\n"
    "2. **start_member(name)** \\u2014 \\u542f\\u52a8\\u4e00\\u4e2a Member \\u8fdb\\u7a0b\\u3002\\u542f\\u52a8\\u540e Member \\u8fdb\\u5165\\u5f85\\u547d\\u72b6\\u6001\\n"
    "3. **team_send_message** \\u2014 \\u901a\\u8fc7\\u6d88\\u606f\\u901a\\u9053\\u7ed9 Member \\u53d1\\u6d88\\u606f\\uff08\\u5206\\u914d\\u4efb\\u52a1\\u3001\\u5171\\u4eab\\u4e0a\\u4e0b\\u6587\\u3001\\u4ea4\\u6d41\\u7b49\\uff09\\u3002\\u4f7f\\u7528\\u65b9\\u5f0f\\u548c\\u53d1\\u9001\\u6d88\\u606f\\u4e00\\u81f4\\uff0c\\u8bbe\\u7f6e to \\u53c2\\u6570\\u4e3a\\u76ee\\u6807 Member \\u540d\\u79f0\\n"
    "4. **list_members** \\u2014 \\u968f\\u65f6\\u67e5\\u770b\\u5404 Member \\u7684\\u8fd0\\u884c\\u72b6\\u6001\\n"
    "5. **get_member_log(name)** \\u2014 \\u67e5\\u770b Member \\u6700\\u8fd1\\u7684\\u5bf9\\u8bdd\\u8bb0\\u5f55\\uff0c\\u4e86\\u89e3\\u8fdb\\u5c55\\n"
    "6. **stop_member(name)** \\u2014 \\u4efb\\u52a1\\u5b8c\\u6210\\u540e\\u7ec8\\u6b62 Member \\u8fdb\\u7a0b"
)

new_prompt = (
    "### \\u53ef\\u7528\\u5de5\\u5177\\n"
    "\\u4f60\\u62e5\\u6709 5 \\u4e2a\\u56e2\\u961f\\u7ba1\\u7406\\u5de5\\u5177\\uff1a\\n\\n"
    "1. **\\u5148\\u5199 Shared Context** \\u2014 \\u7528\\u7f16\\u8f91\\u5668\\u7684 write \\u6216 edit \\u5de5\\u5177\\u521b\\u5efa shared-context.md\\n"
    "2. **start_member(name)** \\u2014 \\u542f\\u52a8\\u4e00\\u4e2a Member \\u8fdb\\u7a0b\\n"
    "3. **team_send_and_wait(to, content, timeout?)** \\u2014 \\u7ed9 Member \\u53d1\\u4efb\\u52a1\\u5e76\\u7b49\\u5f85\\u56de\\u590d\\uff08\\u963b\\u585e\\uff09\\u3002\\u9700\\u8981\\u6210\\u5458\\u7684\\u5904\\u7406\\u7ed3\\u679c\\u65f6\\u4f7f\\u7528\\n"
    "4. **team_send_message(to, subject?, content?)** \\u2014 \\u53ea\\u53d1\\u6d88\\u606f\\u4e0d\\u7b49\\u5f85\\u56de\\u590d\\u3002\\u4ec5\\u901a\\u77e5\\u6216\\u65e0\\u9700\\u7ed3\\u679c\\u65f6\\u4f7f\\u7528\\n"
    "5. **list_members** \\u2014 \\u67e5\\u770b\\u5404 Member \\u7684\\u8fd0\\u884c\\u72b6\\u6001\\n"
    "6. **get_member_log(name, lines?)** \\u2014 \\u67e5\\u770b Member \\u6700\\u8fd1\\u7684\\u5bf9\\u8bdd\\u8bb0\\u5f55\\n"
    "7. **stop_member(name)** \\u2014 \\u7ec8\\u6b62 Member \\u8fdb\\u7a0b\\n\\n"
    "> **\\u63d0\\u793a\\uff1a** team_send_and_wait \\u53d1\\u9001\\u7684\\u6d88\\u606f\\u5305\\u542b <corr:...> \\u6807\\u7b7e\\u3002\\u5176\\u4ed6\\u6210\\u5458\\u56de\\u590d\\u65f6\\u9700\\u5728\\u5185\\u5bb9\\u4e2d\\u5305\\u542b\\u6b64\\u6807\\u7b7e\\uff0c\\u8fd9\\u6837\\u5373\\u4f7f\\u4efb\\u52a1\\u7ecf\\u8fc7\\u591a\\u6b21\\u8f6c\\u4ea4\\uff08A\\u2192B\\u2192TL\\uff09\\uff0c\\u6700\\u7ec8\\u7684\\u56de\\u590d\\u4e5f\\u80fd\\u6b63\\u786e\\u5339\\u914d\\u7b49\\u5f85\\u5668\\u3002\\u6d88\\u606f\\u901a\\u9053\\u4e2d\\u7684 Team Lead \\u540d\\u79f0\\u662f tl\\u3002"
)

if old_prompt in content:
    content = content.replace(old_prompt, new_prompt)
    print("Prompt updated")
else:
    # Try to find the prompt by searching for Japanese characters
    print("Old prompt not found with unicode. Trying raw text...")
    if "你拥有 4 个团队管理工具。使用步骤：" in content:
        # Found by raw Chinese text
        print("Found prompt by Chinese text - will fix manually")
    else:
        print("Not found either way")

open("index.ts", "w", encoding="utf-8").write(content)
