import { describe, it, expect } from "vitest";

import type { MemberOperationalState, MemberEvent } from "./state-machine";
import { transitionState } from "./state-machine";

describe("MemberOperationalState type", () => {
  it("accepts valid state values", () => {
    const idle: MemberOperationalState = "idle";
    const working: MemberOperationalState = "working";
    const crashed: MemberOperationalState = "crashed";
    const stopped: MemberOperationalState = "stopped";
    expect([idle, working, crashed, stopped]).toHaveLength(4);
  });
});

describe("transitionState", () => {
  // ── task_started → working (from any state except crashed) ──
  it("transitions idle → working on task_started", () => {
    expect(transitionState("idle", { type: "task_started" })).toBe("working");
  });

  it("transitions stopped → working on task_started", () => {
    expect(transitionState("stopped", { type: "task_started" })).toBe("working");
  });

  it("transitions working → working on task_started (idempotent)", () => {
    expect(transitionState("working", { type: "task_started" })).toBe("working");
  });

  it("stays crashed on task_started (cannot start a crashed member)", () => {
    expect(transitionState("crashed", { type: "task_started" })).toBe("crashed");
  });

  // ── task_completed → idle ──
  it("transitions working → idle on task_completed", () => {
    expect(transitionState("working", { type: "task_completed" })).toBe("idle");
  });

  it("stays idle on task_completed (idempotent)", () => {
    expect(transitionState("idle", { type: "task_completed" })).toBe("idle");
  });

  it("stays stopped on task_completed", () => {
    expect(transitionState("stopped", { type: "task_completed" })).toBe("stopped");
  });

  it("stays crashed on task_completed", () => {
    expect(transitionState("crashed", { type: "task_completed" })).toBe("crashed");
  });

  // ── process_exit (isCrashLoop=false) → stopped ──
  it("transitions working → stopped on normal process_exit", () => {
    expect(transitionState("working", { type: "process_exit", isCrashLoop: false })).toBe("stopped");
  });

  it("transitions idle → stopped on normal process_exit", () => {
    expect(transitionState("idle", { type: "process_exit", isCrashLoop: false })).toBe("stopped");
  });

  it("stays stopped on normal process_exit (idempotent)", () => {
    expect(transitionState("stopped", { type: "process_exit", isCrashLoop: false })).toBe("stopped");
  });

  it("stays crashed on normal process_exit", () => {
    expect(transitionState("crashed", { type: "process_exit", isCrashLoop: false })).toBe("crashed");
  });

  // ── process_exit (isCrashLoop=true) → crashed ──
  it("transitions working → crashed on crash-loop process_exit", () => {
    expect(transitionState("working", { type: "process_exit", isCrashLoop: true })).toBe("crashed");
  });

  it("transitions idle → crashed on crash-loop process_exit", () => {
    expect(transitionState("idle", { type: "process_exit", isCrashLoop: true })).toBe("crashed");
  });

  it("stays crashed on crash-loop process_exit (idempotent)", () => {
    expect(transitionState("crashed", { type: "process_exit", isCrashLoop: true })).toBe("crashed");
  });

  it("stays stopped on crash-loop process_exit", () => {
    expect(transitionState("stopped", { type: "process_exit", isCrashLoop: true })).toBe("stopped");
  });

  // ── started → idle ──
  it("transitions any state → idle on started", () => {
    expect(transitionState("idle", { type: "started" })).toBe("idle");
    expect(transitionState("working", { type: "started" })).toBe("idle");
    expect(transitionState("crashed", { type: "started" })).toBe("idle");
    expect(transitionState("stopped", { type: "started" })).toBe("idle");
  });

  // ── stopped → stopped ──
  it("transitions any state → stopped on stopped event", () => {
    expect(transitionState("idle", { type: "stopped" })).toBe("stopped");
    expect(transitionState("working", { type: "stopped" })).toBe("stopped");
    expect(transitionState("crashed", { type: "stopped" })).toBe("stopped");
    expect(transitionState("stopped", { type: "stopped" })).toBe("stopped");
  });
});
