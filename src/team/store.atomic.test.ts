import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { writeFile as writeFileAsync, readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * writeTeam 原子化测试（阶段 1 §7.A：临时文件 + 原子替换）。
 *
 * 通过 mock `renameSync` / `writeFileSync` 注入「中途失败」，验证失败时旧文件
 * 内容逐字节不变、临时文件不残留（临时文件名不匹配 *.yaml，不会被当成团队）。
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

import { listTeams, readTeam, writeTeam } from "./store";
import type { TeamDefinition } from "./definition";

const team: TeamDefinition = {
  name: "test-team",
  description: "Atomic write subject",
  members: [{ name: "worker", label: "Worker", systemPrompt: "Do work" }],
};

describe("writeTeam 原子化", () => {
  let rootDir: string;
  let teamsDir: string;
  let filePath: string;
  let actualWriteFileSync: typeof writeFileSync;

  beforeEach(async () => {
    // 每个用例先用真实实现复位（用例内再按需 mockImplementationOnce 注入失败）
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    actualWriteFileSync = actual.writeFileSync;
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync);

    rootDir = mkdtempSync(join(tmpdir(), "team-store-atomic-"));
    teamsDir = join(rootDir, "teams");
    mkdirSync(teamsDir, { recursive: true });
    filePath = join(teamsDir, "test-team.yaml");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("成功写入后无临时文件残留，内容可读回", () => {
    writeTeam(team, rootDir);

    expect(readdirSync(teamsDir)).toEqual(["test-team.yaml"]);
    const loaded = readTeam("test-team", rootDir);
    expect(loaded?.name).toBe("test-team");
    expect(loaded?.members[0].name).toBe("worker");
  });

  it("临时文件名不匹配 *.yaml（不会被 listTeams 当成团队）", async () => {
    // 模拟上次异常退出留下的临时文件
    await writeFileAsync(join(teamsDir, "test-team.yaml.tmp-999"), "half-written", "utf-8");
    writeTeam(team, rootDir);
    expect(listTeams(rootDir)).toEqual(["test-team"]);
  });

  it("替换阶段失败（rename 抛错）→ 原文件内容不变、临时文件清理、错误上抛", async () => {
    const original = "name: original\ndescription: keep me\nmembers: []\n";
    await writeFileAsync(filePath, original, "utf-8");

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EIO: simulated rename failure");
    });

    expect(() => writeTeam(team, rootDir)).toThrow("EIO");

    await expect(readFileAsync(filePath, "utf-8")).resolves.toBe(original);
    expect(readdirSync(teamsDir)).toEqual(["test-team.yaml"]);
  });

  it("临时写入阶段失败 → 原文件内容不变、无半截临时文件", async () => {
    const original = "name: original\ndescription: keep me\nmembers: []\n";
    await writeFileAsync(filePath, original, "utf-8");

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC: simulated write failure");
    });

    expect(() => writeTeam(team, rootDir)).toThrow("ENOSPC");

    await expect(readFileAsync(filePath, "utf-8")).resolves.toBe(original);
    expect(readdirSync(teamsDir)).toEqual(["test-team.yaml"]);
  });

  it("临时写入半途失败（已写入部分内容）→ 原文件不变、临时文件被清理", async () => {
    const original = "name: original\ndescription: keep me\nmembers: []\n";
    await writeFileAsync(filePath, original, "utf-8");

    vi.mocked(writeFileSync).mockImplementationOnce((...args: Parameters<typeof actualWriteFileSync>) => {
      actualWriteFileSync(...args); // 模拟已写入半截内容
      throw new Error("ENOSPC: simulated partial write");
    });

    expect(() => writeTeam(team, rootDir)).toThrow("ENOSPC");

    await expect(readFileAsync(filePath, "utf-8")).resolves.toBe(original);
    expect(readdirSync(teamsDir)).toEqual(["test-team.yaml"]);
  });

  it("首次创建失败不产生目标文件（目录存在、文件不存在）", () => {
    expect(existsSync(filePath)).toBe(false);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EIO: simulated rename failure");
    });
    expect(() => writeTeam(team, rootDir)).toThrow("EIO");
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(teamsDir)).toEqual([]);
  });
});
