/**
 * TL「亲自分析限制」（tlSelfWorkGuard）的数值常量——单一来源，零依赖（纯常量文件）。
 *
 * 单独成文件的理由：`src/session/tl-read-guard.ts` 是运行时守卫的叶模块，只应依赖
 * 常量（不得传递引入设置解析链路 → fs / yaml）。常量放在这里，resolver
 * （`resolve-tl-self-work-guard.ts`）与守卫都只引本文件。
 */

/** 每回合允许的非管理工具调用次数的默认值（= 改造前写死的 3）。 */
export const DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD = 3;

/**
 * 设计阶段的 read 提醒节奏，固定 4 次（与执行阶段次数解耦）。
 * 注释：设计阶段没有可派发对象，「每 N 次提醒一次」与「N 次后持续拦截」是两种
 * 不同语义。放在常量文件里，使提示词可以直接插值（防硬编码与运行时漂移）。
 */
export const DESIGN_READ_GUARD_THRESHOLD = 4;

/**
 * 次数下限 2：团队提示词保证「需求对齐阶段允许读取 1-2 个文件」，上限 < 2 会让该
 * 例外当场失效（提示词与运行时冲突）。`0` 也不接受——它与同菜单里「等待上限 0 =
 * 不限」的约定方向相反，想关闭请用开关。
 */
export const MIN_TL_SELF_WORK_GUARD_THRESHOLD = 2;
