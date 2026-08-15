import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getManifestPath,
  readManifestFile,
  listSessionManifests,
  syncActiveManifest,
  markManifestStopped,
  setManifestRuntimeContext,
  resetManifestRuntimeContext,
} from "./manifest";
import { startSession, endSession, markSharedContextWritten } from "./state";
import type { TeamDefinition } from "../team/definition";

const team: TeamDefinition = {
  name: "think-tank",
  description: "测试团队",
  members: [
    { name: "analyst", label: "分析员", systemPrompt: "分析" },
    { name: "coder", label: "编码员", systemPrompt: "编码" },
  ],
};

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
  process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
  resetManifestRuntimeContext();
});

afterEach(() => {
  endSession();
  resetManifestRuntimeContext();
  rmSync(rootDir, { recursive: true, force: true });
  delete process.env.TOP_NOTCH_TEAM_ROOT;
});

describe("manifest sync", () => {
  it("writes a manifest for the active session", () => {
    startSession(team, { sessionId: "s1" });
    syncActiveManifest();

    const path = getManifestPath(rootDir, "think-tank", "s1");
    const m = readManifestFile(path);
    expect(m).not.toBeNull();
    expect(m!.teamName).toBe("think-tank");
    expect(m!.sessionId).toBe("s1");
    expect(m!.status).toBe("active");
    expect(m!.members.map((x) => x.name)).toEqual(["analyst", "coder"]);
    expect(m!.sharedContextWritten).toBe(false);
    expect(m!.startedMembers).toEqual([]);
  });

  it("is a no-op when no session is active", () => {
    syncActiveManifest();
    expect(listSessionManifests(rootDir)).toEqual([]);
  });

  it("accumulates started members and pids across syncs", () => {
    startSession(team, { sessionId: "s1" });
    syncActiveManifest({ startedMember: { name: "analyst", pid: 111 } });
    syncActiveManifest({ startedMember: { name: "coder", pid: 222 } });

    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.startedMembers.sort()).toEqual(["analyst", "coder"]);
    expect(m.memberPids).toEqual({ analyst: 111, coder: 222 });

    syncActiveManifest({ stoppedMember: "analyst" });
    const m2 = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m2.startedMembers).toEqual(["coder"]);
    expect(m2.memberPids).toEqual({ coder: 222 });
  });

  it("persists goal patches and keeps them across unrelated syncs", () => {
    startSession(team, { sessionId: "s1" });
    syncActiveManifest({ goal: { text: "完成任务", criteria: "- 全部通过" } });
    syncActiveManifest({ startedMember: { name: "analyst", pid: 1 } });

    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.goal).toEqual({ text: "完成任务", criteria: "- 全部通过" });

    syncActiveManifest({ goal: null });
    const m2 = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m2.goal).toBeNull();
  });

  it("captures sharedContextWritten from session state", () => {
    startSession(team, { sessionId: "s1" });
    markSharedContextWritten();
    syncActiveManifest();
    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.sharedContextWritten).toBe(true);
  });

  it("captures dynamic flags from the runtime context", () => {
    startSession(team, { sessionId: "s1", origin: "agent" });
    setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "execution", agentInitiatedTask: "做一件事" });
    syncActiveManifest();

    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.isDynamic).toBe(true);
    expect(m.dynamicPhase).toBe("execution");
    expect(m.origin).toBe("agent");
    expect(m.agentInitiatedTask).toBe("做一件事");
  });
});

describe("markManifestStopped", () => {
  it("marks the manifest stopped and clears pids without deleting the dir", () => {
    startSession(team, { sessionId: "s1" });
    syncActiveManifest({ startedMember: { name: "analyst", pid: 111 } });
    endSession();

    markManifestStopped("think-tank", "s1");
    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.status).toBe("stopped");
    expect(m.memberPids).toEqual({});
    // startedMembers preserved — resume restarts exactly this set
    expect(m.startedMembers).toEqual(["analyst"]);
    expect(existsSync(join(rootDir, "sessions", "think-tank", "s1"))).toBe(true);
  });
});

describe("listSessionManifests", () => {
  it("scans across teams and sorts by lastActiveAt desc", () => {
    startSession(team, { sessionId: "s-old" });
    syncActiveManifest();
    // Force an older timestamp
    const oldPath = getManifestPath(rootDir, "think-tank", "s-old");
    const oldM = readManifestFile(oldPath)!;
    oldM.lastActiveAt = 1000;
    writeFileSync(oldPath, JSON.stringify(oldM));
    endSession();

    startSession({ ...team, name: "dev-team" }, { sessionId: "s-new" });
    syncActiveManifest();
    endSession();

    const list = listSessionManifests(rootDir);
    expect(list.map((e) => e.manifest.sessionId)).toEqual(["s-new", "s-old"]);
  });

  it("skips corrupt manifests", () => {
    const dir = join(rootDir, "sessions", "bad-team", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), "{not json");
    expect(listSessionManifests(rootDir)).toEqual([]);
  });

  it("records the process cwd on sync", () => {
    startSession(team, { sessionId: "s1" });
    syncActiveManifest();
    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "s1"))!;
    expect(m.cwd).toBe(process.cwd());
  });

  it("filters by cwd when the option is given", () => {
    // One manifest from this cwd (via sync)…
    startSession(team, { sessionId: "s-here" });
    syncActiveManifest();
    endSession();
    // …and one from another directory (written directly)
    const otherDir = join(rootDir, "sessions", "other-team", "s-else");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "session.json"), JSON.stringify({
      version: 1, teamName: "other-team", sessionId: "s-else", origin: "user",
      isDynamic: false, dynamicPhase: "execution", status: "active",
      startedAt: 1, lastActiveAt: 2, cwd: "/elsewhere",
      sharedContextWritten: true, goal: null, agentInitiatedTask: null,
      members: [], startedMembers: [], memberPids: {},
    }));

    expect(listSessionManifests(rootDir).map((e) => e.manifest.sessionId).sort())
      .toEqual(["s-else", "s-here"]);
    expect(listSessionManifests(rootDir, { cwd: process.cwd() }).map((e) => e.manifest.sessionId))
      .toEqual(["s-here"]);
    expect(listSessionManifests(rootDir, { cwd: "/elsewhere" }).map((e) => e.manifest.sessionId))
      .toEqual(["s-else"]);
  });
});
