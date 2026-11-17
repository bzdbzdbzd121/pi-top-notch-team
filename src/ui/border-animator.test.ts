/**
 * Heartbeat for the animated team-mode border (plan phase 3).
 *
 * The heartbeat is a single module-level timer that asks the TUI to repaint; the
 * border colour is a pure function of the clock, so a repaint is all that is
 * needed to make it flow. Two safety rules drive the design and the tests below:
 *  - one timer for the whole process (every session creates new editor instances,
 *    and an old instance must not keep a timer alive);
 *  - a watchdog: if nothing has rendered for a while (the editor was replaced or a
 *    dialog took over the layout) the heartbeat stops asking for repaints but
 *    keeps its timer, so the next real render resumes it with no extra state.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BORDER_ANIMATION_ENV,
  CHARS_PER_SECOND,
  CYCLE_MS,
  FRAME_MS,
  STALE_MS,
  borderAnimationEnabled,
  createBorderAnimator,
} from "./border-animator";
import { CYCLE_CHARS } from "./border-gradient";

interface Harness {
  animator: ReturnType<typeof createBorderAnimator>;
  clock: { t: number };
  tui: { requestRender: ReturnType<typeof vi.fn> };
  setIntervalSpy: ReturnType<typeof vi.fn>;
  clearIntervalSpy: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  tick: () => void;
  /** Advance the clock and fire one heartbeat tick. */
  beat: (advanceMs?: number) => void;
}

function createHarness(overrides: { requestRender?: () => void } = {}): Harness {
  const clock = { t: 0 };
  const unref = vi.fn();
  const tui = { requestRender: vi.fn(overrides.requestRender ?? (() => {})) };
  let tick = () => {};
  const clearIntervalSpy = vi.fn();

  const animator = createBorderAnimator({
    now: () => clock.t,
    setInterval: ((handler: () => void) => {
      tick = handler;
      return { unref };
    }) as never,
    clearInterval: clearIntervalSpy as never,
  });

  const beat = (advanceMs = FRAME_MS) => {
    clock.t += advanceMs;
    tick();
  };

  return { animator, clock, tui, setIntervalSpy: vi.fn(), clearIntervalSpy, unref, tick: () => tick(), beat };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("borderAnimationEnabled", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["1", true],
    ["true", true],
    ["on", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["FALSE", false],
    [" off ", false],
  ])("env %j → %s", (value, expected) => {
    const env = value === undefined ? {} : { [BORDER_ANIMATION_ENV]: value };
    expect(borderAnimationEnabled(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it("reads the documented variable name", () => {
    expect(BORDER_ANIMATION_ENV).toBe("TOP_NOTCH_TEAM_BORDER_ANIMATION");
  });
});

describe("createBorderAnimator — lifecycle", () => {
  it("creates exactly one timer per activation and is idempotent", () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    // Real `setInterval` (faked by vitest) so `getTimerCount()` sees it.
    const animator = createBorderAnimator({ now: () => clock.t });
    const tui = { requestRender: vi.fn() };
    animator.attachTui(tui);

    expect(animator.active).toBe(false);
    animator.setActive(true);
    expect(animator.active).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    animator.setActive(true); // repeated activation must not add a timer
    expect(vi.getTimerCount()).toBe(1);

    clock.t += FRAME_MS;
    vi.advanceTimersByTime(FRAME_MS);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    animator.setActive(false);
    expect(animator.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    animator.setActive(false); // idempotent deactivation
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer on dispose", () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    const animator = createBorderAnimator({ now: () => clock.t });
    const tui = { requestRender: vi.fn() };
    animator.attachTui(tui);
    animator.setActive(true);
    expect(vi.getTimerCount()).toBe(1);

    animator.dispose();
    expect(animator.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    animator.dispose(); // idempotent
    expect(vi.getTimerCount()).toBe(0);

    clock.t += FRAME_MS * 2;
    vi.advanceTimersByTime(FRAME_MS * 2); // no zombie timer may fire
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("runs the heartbeat on the frame interval and unrefs the timer", () => {
    vi.useFakeTimers();
    const setIntervalImpl = vi.fn((_handler: () => void, _ms: number) => ({ unref: vi.fn() }));
    const animator = createBorderAnimator({
      now: () => 0,
      setInterval: setIntervalImpl as never,
      clearInterval: vi.fn() as never,
    });
    const tui = { requestRender: vi.fn() };
    animator.attachTui(tui);
    animator.setActive(true);

    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(setIntervalImpl.mock.calls[0]![1]).toBe(FRAME_MS);
    // The handle must not hold the event loop open while the TUI is idle.
    const handle = setIntervalImpl.mock.results[0]!.value as { unref: ReturnType<typeof vi.fn> };
    expect(handle.unref).toHaveBeenCalledTimes(1);
  });

  it("derives the lap time from the spatial period and pi's shimmer speed", () => {
    expect(FRAME_MS).toBe(80);
    expect(STALE_MS).toBe(1000);
    expect(CHARS_PER_SECOND).toBe(10); // pi's provider-brand.js
    expect(CYCLE_CHARS).toBe(16);
    // 16 columns per lap at 10 characters per second = 1.6 s per lap.
    expect(CYCLE_MS).toBe(1600);
    expect(CYCLE_MS).toBe((CYCLE_CHARS / CHARS_PER_SECOND) * 1000);
  });
});

describe("createBorderAnimator — ticks", () => {
  it("requests exactly one render per tick", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);

    expect(h.tui.requestRender).not.toHaveBeenCalled();
    h.beat();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
    h.beat();
    h.beat();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(3);
  });

  it("never requests when inactive", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);

    h.beat();
    h.beat();
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });

  it("stops requesting after deactivation", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);
    h.beat();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);

    h.animator.setActive(false);
    h.beat();
    h.beat();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing requestRender and a missing tui", () => {
    const h = createHarness({
      requestRender: () => {
        throw new Error("render exploded");
      },
    });
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);
    expect(() => h.beat()).not.toThrow();

    const noTui = createHarness();
    noTui.animator.setActive(true);
    expect(() => noTui.beat()).not.toThrow();
  });

  it("sends renders to the most recently attached tui", () => {
    const h = createHarness();
    const first = { requestRender: vi.fn() };
    const second = { requestRender: vi.fn() };
    h.animator.attachTui(first);
    h.animator.setActive(true);
    h.beat();
    expect(first.requestRender).toHaveBeenCalledTimes(1);

    h.animator.attachTui(second);
    h.beat();
    expect(first.requestRender).toHaveBeenCalledTimes(1);
    expect(second.requestRender).toHaveBeenCalledTimes(1);
  });
});

describe("createBorderAnimator — watchdog", () => {
  it("pauses after the stale window and resumes on the next render", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);

    // Fresh renders keep the heartbeat asking for repaints.
    h.beat();
    h.animator.noteRendered(); // last rendered at t = 80
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);

    // Renders stop (a dialog took the layout slot): inside the window it keeps going.
    h.clock.t = 80 + STALE_MS; // exactly 1000 ms since the last render
    h.beat(0);
    expect(h.tui.requestRender).toHaveBeenCalledTimes(2);

    h.clock.t = 80 + STALE_MS + 1; // just past it → paused
    h.beat(0);
    expect(h.tui.requestRender).toHaveBeenCalledTimes(2);
    h.clock.t = 5000;
    h.beat(0);
    expect(h.tui.requestRender).toHaveBeenCalledTimes(2);

    // One real render resumes immediately (no timer rebuild involved).
    h.animator.noteRendered();
    h.beat();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(3);
  });

  it("does not pause while renders keep arriving", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);

    for (let i = 0; i < 10; i++) {
      h.clock.t += FRAME_MS;
      h.animator.noteRendered();
      h.beat(0);
    }
    expect(h.tui.requestRender).toHaveBeenCalledTimes(10);
  });

  it("restarts the stale window on reactivation", () => {
    const h = createHarness();
    h.animator.attachTui(h.tui);
    h.animator.setActive(true);
    h.clock.t = 5000; // long pause while active would have suspended the heartbeat
    h.animator.setActive(false);
    h.animator.setActive(true);
    h.beat(0);
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("exposes its clock for the colour phase", () => {
    const h = createHarness();
    expect(h.animator.now()).toBe(0);
    h.clock.t = 1234;
    expect(h.animator.now()).toBe(1234);
  });
});
