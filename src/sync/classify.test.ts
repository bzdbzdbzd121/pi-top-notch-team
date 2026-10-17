import { describe, it, expect } from "vitest";
import { classifyFile, classifyFiles, type ConflictOption, type FileVersions } from "./classify";

/**
 * 三方比较真值表测试（方案 §7.C，13 行全覆盖）。
 *
 * 内容关系用「可比对的内容令牌」表达：相同内容用同一令牌，不同内容用不同令牌，
 * `null` 表示该侧文件不存在。生产代码里令牌是 git blob id（阶段 2），
 * 本模块只做相等性判定，因此单测用字符串令牌即可。
 */
const B = "content-base";
const L = "content-local";
const R = "content-remote";
const S = "content-shared";

interface Row {
  /** §7.C 行号（1–13）。 */
  n: number;
  desc: string;
  base: string | null;
  local: string | null;
  remote: string | null;
  kind: string;
  options?: ConflictOption[];
}

const THREE_OPTIONS: ConflictOption[] = ["keep-local", "take-remote", "keep-both"];

const ROWS: Row[] = [
  // #1 三方相同 / 两边改成同一新内容 → 无变化
  { n: 1, desc: "三方相同", base: B, local: B, remote: B, kind: "unchanged" },
  { n: 1, desc: "两边都改成同一新内容（L=R≠B）", base: B, local: S, remote: S, kind: "unchanged" },
  // #2 仅本机改
  { n: 2, desc: "仅本机改", base: B, local: L, remote: B, kind: "local-modified" },
  // #3 仅云端改
  { n: 3, desc: "仅云端改", base: B, local: B, remote: R, kind: "remote-modified" },
  // #4 两边新增且相同
  { n: 4, desc: "两边新增且内容相同", base: null, local: S, remote: S, kind: "unchanged" },
  // #5 add/add
  { n: 5, desc: "两边新增同名不同内容（add/add）", base: null, local: L, remote: R, kind: "conflict", options: THREE_OPTIONS },
  // #6 两边都改
  { n: 6, desc: "两边都改（both-modified）", base: B, local: L, remote: R, kind: "conflict", options: THREE_OPTIONS },
  // #7 本机删 + 云端改 → 恢复云端 / 保持删除（先「保留对方版本」）
  { n: 7, desc: "本机删 + 云端改（delete/modify）", base: B, local: null, remote: R, kind: "conflict", options: ["take-remote", "keep-local"] },
  // #8 本机改 + 云端删 → 保留本机（重新上传）/ 接受删除
  { n: 8, desc: "本机改 + 云端删（modify/delete）", base: B, local: L, remote: null, kind: "conflict", options: ["keep-local", "take-remote"] },
  // #9 仅本机删
  { n: 9, desc: "仅本机删（云端未动）", base: B, local: null, remote: B, kind: "local-deleted" },
  // #10 仅云端删
  { n: 10, desc: "仅云端删（本机未动）", base: B, local: B, remote: null, kind: "remote-deleted" },
  // #11 两边都删
  { n: 11, desc: "两边都删", base: B, local: null, remote: null, kind: "both-deleted" },
  // #12 仅本机新增
  { n: 12, desc: "仅本机新增", base: null, local: L, remote: null, kind: "local-only" },
  // #13 仅云端新增
  { n: 13, desc: "仅云端新增", base: null, local: null, remote: R, kind: "remote-only" },
];

describe("classifyFile（§7.C 分类真值表）", () => {
  it("真值表覆盖 §7.C 全部 13 行（防漏行守卫）", () => {
    const covered = [...new Set(ROWS.map((r) => r.n))].sort((a, b) => a - b);
    expect(covered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it.each(ROWS)("#$n $desc → $kind", (row) => {
    const versions: FileVersions = {
      path: "team.yaml",
      base: row.base,
      local: row.local,
      remote: row.remote,
    };
    const result = classifyFile(versions);

    expect(result.kind, row.desc).toBe(row.kind);
    expect(result.path).toBe("team.yaml");
    if (row.options) {
      expect(result).toHaveProperty("options");
      expect((result as { options: ConflictOption[] }).options).toEqual(row.options);
    } else {
      expect(result).not.toHaveProperty("options");
    }
  });

  it("首次接入（基准为空）退化为四类差异", () => {
    // 基准缺失时：相同 → 无变化；仅本机 → 上传；仅云端 → 下载；两边不同 → 冲突
    expect(classifyFile({ path: "a.yaml", base: null, local: S, remote: S })).toEqual({ kind: "unchanged", path: "a.yaml" });
    expect(classifyFile({ path: "b.yaml", base: null, local: L, remote: null }).kind).toBe("local-only");
    expect(classifyFile({ path: "c.yaml", base: null, local: null, remote: R }).kind).toBe("remote-only");
    expect(classifyFile({ path: "d.yaml", base: null, local: L, remote: R }).kind).toBe("conflict");
  });

  it("三处皆无内容属调用方枚举错误 → 按无动作兜底（fail-safe）", () => {
    const result = classifyFile({ path: "ghost.yaml", base: null, local: null, remote: null });
    expect(result).toEqual({ kind: "unchanged", path: "ghost.yaml" });
  });

  it("内容令牌相同即判无变化（与 git blob id 语义一致，不做文本解析）", () => {
    const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    expect(classifyFile({ path: "x.yaml", base: blob, local: blob, remote: blob }).kind).toBe("unchanged");
    // 两侧都改成同一个新 blob（两边都动了但内容一致）→ 无变化
    const newBlob = "1111111111111111111111111111111111111111";
    expect(classifyFile({ path: "x.yaml", base: blob, local: newBlob, remote: newBlob }).kind).toBe("unchanged");
  });
});

describe("classifyFiles", () => {
  it("保持输入顺序与路径，逐项分类", () => {
    const results = classifyFiles([
      { path: "a.yaml", base: B, local: L, remote: B },
      { path: "b.yaml", base: B, local: null, remote: R },
      { path: "c.yaml", base: null, local: L, remote: null },
    ]);
    expect(results).toEqual([
      { kind: "local-modified", path: "a.yaml" },
      { kind: "conflict", path: "b.yaml", options: ["take-remote", "keep-local"] },
      { kind: "local-only", path: "c.yaml" },
    ]);
  });

  it("空输入返回空结果", () => {
    expect(classifyFiles([])).toEqual([]);
  });
});
