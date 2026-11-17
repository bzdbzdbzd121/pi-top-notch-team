/**
 * Heartbeat for the animated team-mode border (plan phase 3).
 *
 * The border colour is a pure function of the clock, so making it flow only needs
 * somebody to ask the TUI for a repaint every frame. This module is that
 * somebody — and it is the only periodic repaint source the extension adds.
 *
 * Two rules shape the design:
 *  - **One timer per process.** Every session creates new editor instances and
 *    old instances are never destroyed (pi only clears its container array), so a
 *    per-instance timer could keep repainting a border that is no longer on
 *    screen. Callers share `sharedBorderAnimator`.
 *  - **Invisible ⇒ no requests.** A render watchdog pauses the requests when
 *    nothing has rendered for a while (editor replaced by another extension, or
 *    a selector/dialog took the layout slot). The timer keeps running — it is one
 *    clock read plus a comparison per frame — so the next real render resumes the
 *    heartbeat with no extra state to unwind.
 *
 * Cost, measured on 120 columns: two border lines, 32 colour stops, 12.5 fps
 * ≈ 16 KB/s of terminal traffic in truecolor (≈ 7.6 KB/s with 256 colours), plus
 * one full repaint per frame (~0.2 ms short session, ~2 ms with 8000 lines of
 * history in the synthetic benchmark).
 */

import { CYCLE_CHARS } from "./border-gradient";

/** Set to `0`, `false` or `off` to keep the static gradient and create no timer. */
export const BORDER_ANIMATION_ENV = "TOP_NOTCH_TEAM_BORDER_ANIMATION";

/**
 * Characters per second the pattern advances — taken from pi's own brand
 * shimmer (`pi-coding-agent/dist/modes/interactive/components/provider-brand.js`
 * in the 1.5.x release: `const CHARS_PER_SECOND = 10;`).
 */
export const CHARS_PER_SECOND = 10;

/**
 * Time for one full lap around the palette.
 *
 * Derived, not tuned: the pattern spans `CYCLE_CHARS` (= 16, see
 * `border-gradient.ts`) columns, and the login screen moves it at
 * `CHARS_PER_SECOND` = 10 characters per second, so one lap takes
 * 16 / 10 = 1.6 s. Under the 80 ms heartbeat the pattern shifts
 * 10 × 0.08 = 0.8 characters per frame (pi's own screen renders every 50 ms,
 * i.e. 0.5 characters per frame): same speed, coarser sampling, which is why the
 * colour is interpolated per column instead of stepping band by band.
 */
export const CYCLE_MS = (CYCLE_CHARS / CHARS_PER_SECOND) * 1000;

/** Heartbeat interval: 12.5 frames per second, the cheapest smooth-looking rate. */
export const FRAME_MS = 80;

/** No render for this long ⇒ the border is not visible ⇒ stop requesting repaints. */
export const STALE_MS = 1000;

/** The part of the TUI the heartbeat needs. */
export interface TuiLike {
  requestRender?: (force?: boolean) => void;
}

export interface AnimatorDeps {
  /** Clock in milliseconds; defaults to `performance.now`. */
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  frameMs?: number;
  staleMs?: number;
}

export interface BorderAnimator {
  /** Point repaint requests at this TUI (the editor's constructor does this). */
  attachTui(tui: TuiLike | undefined): void;
  /** Start/stop the heartbeat. Idempotent: repeated calls never add a timer. */
  setActive(active: boolean): void;
  /** Mark "a real render just happened" — feeds the watchdog. Called from render(). */
  noteRendered(): void;
  /** Stop the heartbeat and forget the TUI. Idempotent. */
  dispose(): void;
  /** The animator's clock, so the colour phase and the heartbeat share one time source. */
  now(): number;
  readonly active: boolean;
}

/**
 * Is the border animation enabled? Only `0`/`false`/`off` (any case, padded)
 * disable it — an unset, empty or unrecognised value keeps the default (on),
 * so a typo can never silently freeze a border the user expected to flow.
 */
export function borderAnimationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BORDER_ANIMATION_ENV];
  if (typeof raw !== "string") return true;
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

export function createBorderAnimator(deps: AnimatorDeps = {}): BorderAnimator {
  const clock = deps.now ?? (() => performance.now());
  const startTimer = deps.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const stopTimer = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const frameMs = deps.frameMs ?? FRAME_MS;
  const staleMs = deps.staleMs ?? STALE_MS;

  let tui: TuiLike | undefined;
  let timer: unknown = null;
  let active = false;
  let lastRenderedAt = clock();

  const tick = (): void => {
    if (!active) return;
    // Watchdog: the border is not being rendered, so a repaint would cost a full
    // screen diff for nothing. Keep the timer; noteRendered() resumes us.
    if (clock() - lastRenderedAt > staleMs) return;
    try {
      tui?.requestRender?.();
    } catch {
      // Fail-open: a throwing TUI must not kill the heartbeat (let alone the process).
    }
  };

  const stop = (): void => {
    if (timer === null) return;
    try {
      stopTimer(timer);
    } catch {
      // Fail-open: a broken clearInterval must not leave `timer` stuck.
    }
    timer = null;
  };

  return {
    attachTui(next) {
      tui = next;
    },

    setActive(next) {
      if (next === active) return;
      active = next;
      if (!next) {
        stop();
        return;
      }
      // Activation counts as "just rendered": give the first frame a full stale
      // window before a missing render can pause the heartbeat.
      lastRenderedAt = clock();
      if (timer !== null) return;
      timer = startTimer(tick, frameMs);
      // Never hold the event loop open for an animation (pi may be shutting down).
      const handle = timer as { unref?: () => void } | null;
      try {
        handle?.unref?.();
      } catch {
        // Fail-open: unref is an optimisation, not a correctness requirement.
      }
    },

    noteRendered() {
      lastRenderedAt = clock();
    },

    dispose() {
      active = false;
      stop();
      tui = undefined;
    },

    now() {
      return clock();
    },

    get active() {
      return active;
    },
  };
}

/**
 * Process-wide heartbeat. Every editor instance shares it, so two editors (or a
 * dangling old instance plus the live one) can never produce two timers.
 */
export const sharedBorderAnimator: BorderAnimator = createBorderAnimator();
