import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_SYNC_CONFIG,
  getSyncConfigPath,
  isValidRemoteUrl,
  loadSyncConfig,
  maskRemoteUrl,
  normalizeRemoteUrl,
  saveSyncConfig,
  validateRemoteUrl,
} from "./config";

describe("SyncConfig 地址校验矩阵（方案 §7.B）", () => {
  const VALID = [
    "https://github.com/user/repo.git",
    "https://gitlab.com/group/sub/repo.git",
    "HTTPS://github.com/user/repo.git",
    "ssh://git@github.com/user/repo.git",
    "ssh://git@github.com:2222/user/repo.git",
    "git@github.com:user/repo.git",
    "user@example.com:repos/team-defs.git",
    "file:///home/user/repos/team-defs",
    "/home/user/repos/team-defs",
    "/home/user/my repos/team-defs", // 本地绝对路径允许空格
    "C:\\repos\\team-defs",
    "https://github.com/user/repo.git ", // 首尾空白先 trim 再校验
    "  git@github.com:user/repo.git",
  ];

  const INVALID: [string, string][] = [
    ["", "空"],
    ["   ", "纯空白"],
    ["-u /tmp/x", "以 - 开头（会被当成命令选项）"],
    [" --upload-pack=evil", "trim 后以 - 开头"],
    ["https://user@github.com/u/r.git", "https 内嵌用户名"],
    ["https://user:secret@github.com/u/r.git", "https 内嵌用户名+密码"],
    ["https://ghp_token@github.com/u/r.git", "https 内嵌 token"],
    ["ssh://user:secret@github.com/u/r.git", "任何 scheme 内嵌密码（审查 #4）"],
    ["ssh://git:secret@github.com/u/r.git", "ssh 内嵌密码"],
    ["http://github.com/u/r.git", "不支持的协议 http"],
    ["git://github.com/u/r.git", "不支持的协议 git"],
    ["ftp://example.com/x", "不支持的协议 ftp"],
    ["https://github.com", "缺少仓库路径"],
    ["ssh://git@github.com", "缺少仓库路径"],
    ["file://", "缺少路径"],
    ["not a url", "既非 URL 协议也非绝对路径"],
    ["relative/path", "相对路径"],
    ["~/repos/team-defs", "~ 开头（非绝对路径）"],
    ["git@github.com:user/repo with space.git", "scp 路径含空白"],
    ["https://github.com/u/r.git\nrm -rf /", "含控制字符"],
  ];

  it.each(VALID)("接受 %j", (url) => {
    expect(validateRemoteUrl(url)).toBeNull();
    expect(isValidRemoteUrl(url)).toBe(true);
  });

  it.each(INVALID)("拒绝 %j（%s）", (url) => {
    const err = validateRemoteUrl(url);
    expect(err).toBeTruthy();
    expect(isValidRemoteUrl(url)).toBe(false);
  });

  it("https 内嵌凭据的拒绝理由说明原因", () => {
    expect(validateRemoteUrl("https://user:pass@github.com/u/r.git")).toContain("内嵌");
    // ssh://git@host/path 允许（git 不是秘密）；带密码一律拒绝
    expect(validateRemoteUrl("ssh://git@github.com/u/r.git")).toBeNull();
    expect(validateRemoteUrl("ssh://user:secret@github.com/u/r.git")).toContain("密码");
  });

  it("normalizeRemoteUrl 只做首尾去空白", () => {
    expect(normalizeRemoteUrl("  https://github.com/u/r.git\n")).toBe("https://github.com/u/r.git");
    expect(normalizeRemoteUrl("https://github.com/u/r.git")).toBe("https://github.com/u/r.git");
    expect(normalizeRemoteUrl("git@github.com:u/r.git")).toBe("git@github.com:u/r.git");
  });
});

describe("maskRemoteUrl（展示脱敏）", () => {
  it.each([
    ["https://user:pass@github.com/u/r.git", "https://***@github.com/u/r.git"],
    ["https://token@github.com/u/r.git", "https://***@github.com/u/r.git"],
    ["https://github.com/u/r.git", "https://github.com/u/r.git"],
    ["https://github.com/u/r@2.git", "https://github.com/u/r@2.git"], // 路径含 @ 不误判（审查 #5）
    ["https://user@github.com/u/r@2.git", "https://***@github.com/u/r@2.git"],
    ["https://user:pa@ss@github.com/u/r.git", "https://***@github.com/u/r.git"],
    ["ssh://git@github.com/u/r.git", "ssh://git@github.com/u/r.git"],
    ["ssh://git@github.com:2222/u/r.git", "ssh://git@github.com:2222/u/r.git"],
    ["ssh://user:pass@github.com/u/r.git", "ssh://user:***@github.com/u/r.git"],
    ["git@github.com:u/r.git", "git@github.com:u/r.git"],
    ["/home/user/repos/team-defs", "/home/user/repos/team-defs"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(maskRemoteUrl(input)).toBe(expected);
  });
});

describe("sync.yaml 读写", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "sync-config-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const readRaw = (): Record<string, unknown> =>
    parseYaml(readFileSync(getSyncConfigPath(rootDir), "utf-8")) as Record<string, unknown>;

  it("配置路径为 <rootDir>/sync.yaml", () => {
    expect(getSyncConfigPath(rootDir)).toBe(join(rootDir, "sync.yaml"));
  });

  it("文件缺失 → 未配置（null）", () => {
    expect(loadSyncConfig(rootDir)).toBeNull();
  });

  it("保存后往返读取一致", () => {
    const config = { enabled: true, remoteUrl: "git@github.com:user/team-defs.git", branch: "main" };
    saveSyncConfig(config, rootDir);

    expect(existsSync(getSyncConfigPath(rootDir))).toBe(true);
    expect(loadSyncConfig(rootDir)).toEqual(config);
  });

  it("保存时对地址做首尾去空白（normalize）", () => {
    saveSyncConfig({ enabled: true, remoteUrl: "  https://github.com/u/r.git ", branch: "" }, rootDir);
    expect(loadSyncConfig(rootDir)!.remoteUrl).toBe("https://github.com/u/r.git");
  });

  it("目录不存在时自动创建", () => {
    const nested = join(rootDir, "nested", "root");
    saveSyncConfig({ ...DEFAULT_SYNC_CONFIG, remoteUrl: "/tmp/repo" }, nested);
    expect(existsSync(getSyncConfigPath(nested))).toBe(true);
  });

  it("未知键在写回时保留", () => {
    writeFileSync(
      getSyncConfigPath(rootDir),
      [
        "enabled: false",
        "remoteUrl: ''",
        "branch: ''",
        "futureKey: keep-me",
        "nested:",
        "  a: 1",
        "",
      ].join("\n"),
      "utf-8"
    );

    saveSyncConfig({ enabled: true, remoteUrl: "https://github.com/u/r.git", branch: "main" }, rootDir);
    const raw = readRaw();

    expect(raw.futureKey).toBe("keep-me");
    expect(raw.nested).toEqual({ a: 1 });
    expect(raw.enabled).toBe(true);
    expect(raw.remoteUrl).toBe("https://github.com/u/r.git");
    expect(raw.branch).toBe("main");
  });

  it("损坏文件 → 视为未配置（fail-open，不抛错）", () => {
    writeFileSync(getSyncConfigPath(rootDir), "{{{{ not yaml", "utf-8");
    expect(loadSyncConfig(rootDir)).toBeNull();
    // 损坏文件仍可被覆盖保存
    saveSyncConfig({ enabled: true, remoteUrl: "/tmp/repo", branch: "" }, rootDir);
    expect(loadSyncConfig(rootDir)).toEqual({ enabled: true, remoteUrl: "/tmp/repo", branch: "" });
  });

  it("YAML 根不是对象（字符串/数组）→ 未配置", () => {
    writeFileSync(getSyncConfigPath(rootDir), "just a string", "utf-8");
    expect(loadSyncConfig(rootDir)).toBeNull();
    writeFileSync(getSyncConfigPath(rootDir), "- a\n- b\n", "utf-8");
    expect(loadSyncConfig(rootDir)).toBeNull();
  });

  it("字段类型非法 → 回退默认值（enabled 严格 === true）", () => {
    writeFileSync(
      getSyncConfigPath(rootDir),
      ["enabled: 'yes'", "remoteUrl: 123", "branch: [1, 2]", ""].join("\n"),
      "utf-8"
    );
    expect(loadSyncConfig(rootDir)).toEqual(DEFAULT_SYNC_CONFIG);
  });

  it("enabled 缺省 → false（只有显式 true 才算启用）", () => {
    writeFileSync(getSyncConfigPath(rootDir), "remoteUrl: /tmp/repo\n", "utf-8");
    const loaded = loadSyncConfig(rootDir)!;
    expect(loaded.enabled).toBe(false);
    expect(loaded.remoteUrl).toBe("/tmp/repo");
    expect(loaded.branch).toBe("");
  });

  it("写入采用临时文件 + 原子替换，不留 .tmp 残留", () => {
    saveSyncConfig({ enabled: true, remoteUrl: "/tmp/repo", branch: "" }, rootDir);
    const leftovers = readdirSync(rootDir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("读取时校验地址：非法值被清空并 warn（审查 #3）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(
        getSyncConfigPath(rootDir),
        ["enabled: true", "remoteUrl: '--upload-pack=evil'", "branch: main", ""].join("\n"),
        "utf-8"
      );
      const loaded = loadSyncConfig(rootDir)!;
      expect(loaded.remoteUrl).toBe("");
      expect(loaded.enabled).toBe(true); // 其余字段保留
      expect(loaded.branch).toBe("main");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("仓库地址非法"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("读取时校验地址：内嵌凭据值被清空（不进入 git 命令）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(
        getSyncConfigPath(rootDir),
        ["enabled: true", "remoteUrl: 'https://user:secret@github.com/u/r.git'", "branch: ''", ""].join("\n"),
        "utf-8"
      );
      expect(loadSyncConfig(rootDir)!.remoteUrl).toBe("");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("非法地址重复读取只 warn 一次（防刷屏）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(getSyncConfigPath(rootDir), "remoteUrl: '--upload-pack=evil'\n", "utf-8");
      expect(loadSyncConfig(rootDir)!.remoteUrl).toBe("");
      expect(loadSyncConfig(rootDir)!.remoteUrl).toBe("");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("读取时对地址去首尾空白（normalize）", () => {
    writeFileSync(
      getSyncConfigPath(rootDir),
      ['enabled: true', "remoteUrl: '  https://github.com/u/r.git  '", "branch: ''", ""].join("\n"),
      "utf-8"
    );
    expect(loadSyncConfig(rootDir)!.remoteUrl).toBe("https://github.com/u/r.git");
  });

  it("写入非法地址 → 显式报错且不落盘（审查 #3 双保险）", () => {
    expect(() =>
      saveSyncConfig({ enabled: true, remoteUrl: "--upload-pack=evil", branch: "" }, rootDir)
    ).toThrow(/非法/);
    expect(existsSync(getSyncConfigPath(rootDir))).toBe(false);
  });

  it("写入非法地址不会覆盖已有合法配置", () => {
    const config = { enabled: true, remoteUrl: "https://github.com/u/r.git", branch: "main" };
    saveSyncConfig(config, rootDir);
    expect(() =>
      saveSyncConfig({ enabled: true, remoteUrl: "https://user:secret@github.com/u/r.git", branch: "" }, rootDir)
    ).toThrow();
    expect(loadSyncConfig(rootDir)).toEqual(config);
  });

  it.skipIf(process.platform === "win32")("写入后的 sync.yaml 权限为 0600（审查 #4）", () => {
    saveSyncConfig({ enabled: true, remoteUrl: "https://github.com/u/r.git", branch: "" }, rootDir);
    const mode = statSync(getSyncConfigPath(rootDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("已有 0600 配置被覆盖后仍为 0600（rename 不降权）", () => {
    saveSyncConfig({ enabled: true, remoteUrl: "https://github.com/u/r.git", branch: "" }, rootDir);
    chmodSync(getSyncConfigPath(rootDir), 0o600);
    saveSyncConfig({ enabled: false, remoteUrl: "https://github.com/u/r.git", branch: "dev" }, rootDir);
    expect(statSync(getSyncConfigPath(rootDir)).mode & 0o777).toBe(0o600);
  });

  it("保存失败（目标目录不可写）不吞错、不留半截文件", () => {
    // rootDir 本身作为文件存在 → mkdir 失败
    const badRoot = join(rootDir, "as-file");
    writeFileSync(badRoot, "x", "utf-8");
    mkdirSync(join(rootDir, "ok"), { recursive: true });
    expect(() => saveSyncConfig({ enabled: true, remoteUrl: "/tmp/repo", branch: "" }, badRoot)).toThrow();
    expect(existsSync(getSyncConfigPath(badRoot))).toBe(false);
  });
});
