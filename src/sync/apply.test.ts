import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { archiveFileName, isArchiveFileName, syncConflictsDir } from "./apply";

const AT = new Date(2026, 9, 17, 12, 1, 0); // 2026-10-17 12:01:00
const HASH = "[0-9a-f]{8}";

describe("归档目录与命名（偏差 1：复用阶段 4 的规则）", () => {
  it("归档目录固定为 <rootDir>/sync-conflicts（不在 teams/ 内）", () => {
    expect(syncConflictsDir("/home/u/.pi/top-notch-team")).toBe("/home/u/.pi/top-notch-team/sync-conflicts");
    expect(syncConflictsDir("/home/u/.pi/top-notch-team").includes("/teams/")).toBe(false);
  });

  it("命名 = <路径安全化>-<原路径短哈希>.<YYYYMMDD-HHmmss>", () => {
    expect(archiveFileName("README.md", AT)).toMatch(new RegExp(`^README\\.md-${HASH}\\.20261017-120100$`));
    expect(archiveFileName("refactoring.yaml", AT)).toMatch(new RegExp(`^refactoring\\.yaml-${HASH}\\.20261017-120100$`));
  });

  it("不同路径同秒不撞名（中文名必现碰撞的场景；保留可读名）", () => {
    const names = ["a b.txt", "a_b.txt", "说明.md", "指南.md", "我的 团队.txt", "归档文档.txt"].map((p) =>
      archiveFileName(p, AT)
    );
    expect(new Set(names).size).toBe(names.length); // 全部唯一
    expect(names[2]).toMatch(new RegExp(`^说明\\.md-${HASH}\\.20261017-120100$`)); // 中文不被折成 `_md`
    expect(names[4]).toMatch(new RegExp(`^我的 团队\\.txt-${HASH}\\.20261017-120100$`));
  });

  it("同一路径同一秒可用序号兜底（绝不覆盖已有留档）", () => {
    const first = archiveFileName("README.md", AT);
    const second = archiveFileName("README.md", AT, 2);
    expect(second).not.toBe(first);
    expect(second).toMatch(new RegExp(`^README\\.md-${HASH}-2\\.20261017-120100$`));
  });

  it("路径分隔符/非法字符安全化；前导点折叠、结尾点空格去除、空名兜底", () => {
    expect(archiveFileName("sub/notes.md", AT)).toMatch(new RegExp(`^sub_notes\\.md-${HASH}\\.`));
    expect(archiveFileName("weird\\name.yaml", AT)).toMatch(new RegExp(`^weird_name\\.yaml-${HASH}\\.`));
    expect(archiveFileName("../escape.yaml", AT)).toMatch(new RegExp(`^_escape\\.yaml-${HASH}\\.`));
    expect(archiveFileName("a b:c?.yaml", AT)).toMatch(new RegExp(`^a b_c_\\.yaml-${HASH}\\.`));
    expect(archiveFileName("", AT)).toMatch(new RegExp(`^file-${HASH}\\.`));
    expect(archiveFileName("notes.  ", AT)).toMatch(new RegExp(`^notes-${HASH}\\.`));
  });

  it("Windows 保留设备名加前缀规避", () => {
    for (const name of ["CON", "com1", "LPT9.txt", "aux.yaml"]) {
      expect(archiveFileName(name, AT)).toMatch(new RegExp(`^_${name.replace(".", "\\.")}-${HASH}\\.`));
    }
    expect(archiveFileName("console.txt", AT)).toMatch(new RegExp(`^console\\.txt-${HASH}\\.`)); // 非保留名不动
  });

  it("join 后仍位于归档目录内（无路径逃逸）", () => {
    const dir = syncConflictsDir("/root");
    for (const p of ["../escape.yaml", "../../etc/passwd", "/etc/passwd", "..", "."]) {
      expect(join(dir, archiveFileName(p, AT)).startsWith(`${dir}/`)).toBe(true);
    }
  });

  it("isArchiveFileName 识别本规则与阶段 4 形态，拒绝普通文件名", () => {
    expect(isArchiveFileName(archiveFileName("README.md", AT))).toBe(true);
    expect(isArchiveFileName("refactoring.20261017-1201.yaml")).toBe(true);
    expect(isArchiveFileName("说明.md-0a1b2c3d.20261017-120100")).toBe(true);
    expect(isArchiveFileName("README.md")).toBe(false);
    expect(isArchiveFileName("notes.txt")).toBe(false);
    expect(isArchiveFileName("20261017-1201.yaml")).toBe(false);
  });
});
