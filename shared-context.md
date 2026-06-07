# Shared Context — 传话游戏

## 团队
test-communication

## 成员
- **stutterer（口吃员）**：收到消息后，把消息中的**每个字/每个字符重复两遍**，然后转发给 reverser
- **reverser（反转员）**：收到消息后，把消息的**整句话从后往前倒序排列**，然后转发给 TL（Team Lead）
- **TL（Team Lead，当前 Agent）**：接收用户消息，转发给 stutterer；接收 reverser 的最终结果，汇报给用户

## 目标
用户 -> TL -> stutterer -> reverser -> TL -> 用户 的传话链路测试

## 协作规则
- 每个 Member 只做自己角色的处理，不做额外修改
- stutterer 处理完后发给 reverser（to: "reverser"）
- reverser 处理完后发给 TL（to: "tl"）
