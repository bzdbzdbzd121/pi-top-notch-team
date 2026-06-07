content = open("src/tools/tl-tools.ts", "r", encoding="utf-8").read()

# Add promptGuidelines to start_member
content = content.replace(
    'description:\n      "Launch a Member\\'s pi RPC process. The Member will be available for task assignment via the message channel. " +\n      "Parameters: name (member identifier from the team definition).",\n    parameters:',
    'description:\n      "Launch a Member\\'s pi RPC process. The Member will be available for task assignment via the message channel. " +\n      "Parameters: name (member identifier from the team definition).",\n    promptGuidelines: [\n      "Use start_member to launch a Member RPC process after writing the Shared Context document.",\n    ],\n    parameters:'
)

# Add to stop_member
content = content.replace(
    'description:\n      "Gracefully terminate a Member\\'s pi RPC process. " +\n      "Parameters: name (member identifier).",\n    parameters:',
    'description:\n      "Gracefully terminate a Member\\'s pi RPC process. " +\n      "Parameters: name (member identifier).",\n    promptGuidelines: [\n      "Use stop_member to terminate a Member process when its task is complete or when ending the team session.",\n    ],\n    parameters:'
)

# Add to list_members
content = content.replace(
    'description: "Show the current status of all team members.",\n    parameters: {',
    'description: "Show the current status of all team members.",\n    promptGuidelines: [\n      "Use list_members to check the status of all team members (running/stopped/error) during a team session.",\n    ],\n    parameters: {'
)

# Add to get_member_log
content = content.replace(
    'description:\n      "Retrieve a Member\\'s recent conversation log to check their progress. " +\n      "Parameters: name (member identifier), lines (number of recent lines, default 10).",\n    parameters:',
    'description:\n      "Retrieve a Member\\'s recent conversation log to check their progress. " +\n      "Parameters: name (member identifier), lines (number of recent lines, default 10).",\n    promptGuidelines: [\n      "Use get_member_log to review a Member\\'s recent conversation and track their progress on assigned tasks.",\n    ],\n    parameters:'
)

open("src/tools/tl-tools.ts", "w", encoding="utf-8").write(content)
print("Done")
