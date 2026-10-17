import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { archiveFileName, syncConflictsDir } from "./apply";

describe("归档目录与命名（偏差 1：复用阶段 4 的规则）", () => {
  it("归档目录固定为 <rootDir>/sync-conflicts（不在 teams/ 内）", () => {
    expect(syncConflictsDir("/home/u/.pi/top-notch-team")).toBe("/home/u/.pi/top-notch-team/sync-conflicts");
    expect(syncConflictsDir("/home/u/.pi/top-notch-team").includes("/teams/")).toBe(false);
  });

  it("命名 = <路径安全化>.<YYYYMMDD-HHmmss>", () => {
    const at = new Date(2026, 9, 17, 12, 1, 0); // 2026-10-17 12:01:00
    expect(archiveFileName("README.md", at)).toBe("README.md.20261017-120100");
    expect(archiveFileName("refactoring.yaml", at)).toBe("refactoring.yaml.20261017-120100");
  });

  it("路径分隔符与特殊字符安全化（子目录/反斜杠/空格）；前导点与空名兜底", () => {
    const at = new Date(2026, 9, 17, 12, 1, 0);
    expect(archiveFileName("sub/notes.md", at)).toBe("sub_notes.md.20261017-120100");
    expect(archiveFileName("weird\\name.yaml", at)).toBe("weird_name.yaml.20261017-120100");
    expect(archiveFileName("a b:c?.yaml", at)).toBe("a_b_c_.yaml.20261017-120100");
    expect(archiveFileName("../escape.yaml", at)).toBe("_escape.yaml.20261017-120100");
    expect(archiveFileName("", at)).toBe("file.20261017-120100");
  });

  it("同名两次归档时间戳到秒 → 不同运行不互相覆盖（除同一秒内）", () => {
    const a = archiveFileName("README.md", new Date(2026, 9, 17, 12, 1, 0));
    const b = archiveFileName("README.md", new Date(2026, 9, 17, 12, 1, 1));
    expect(a).not.toBe(b);
  });

  it("join 后仍位于归档目录内（无路径逃逸）", () => {
    const dir = syncConflictsDir("/root");
    const name = archiveFileName("../escape.yaml", new Date(2026, 9, 17, 12, 1, 0));
    expect(join(dir, name).startsWith(`${dir}/`)).toBe(true);
  });
});
