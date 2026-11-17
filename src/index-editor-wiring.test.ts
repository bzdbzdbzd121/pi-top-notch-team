/**
 * Editor wiring: team sessions must start and stop the border heartbeat.
 *
 * The heartbeat itself lives in the editor (`setTeamMode` → animator), so what is
 * asserted here is the lifecycle in `index.ts`:
 *  - entering a session (`/team start`, `/team dynamic`) registers the editor
 *    factory, and the editor that pi creates is switched into team mode;
 *  - leaving a session (`/team stop`, `session_shutdown` incl. `/reload`) stops
 *    the border BEFORE pi swaps back to the default editor — the order matters,
 *    a dangling instance must never keep a timer alive.
 *
 * `TeamModeEditor` is mocked so the test observes the calls instead of pixels;
 * the real editor's heartbeat behaviour is covered in team-mode-editor.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "./test/fixtures/mock-extension-api";

const { editors } = vi.hoisted(() => ({ editors: [] as Array<{ setTeamMode: ReturnType<typeof vi.fn> }> }));

vi.mock("./ui/team-mode-editor", () => ({
  isBashModeText: () => false,
  TeamModeEditor: class {
    setTeamMode = vi.fn();
    constructor(_tui: unknown, _theme: unknown, _kb: unknown, _fullTheme: unknown) {
      editors.push(this);
    }
  },
}));

vi.mock("./process/member-process", () => ({
  createMemberProcess: vi.fn(),
  hasSessionFiles: () => false,
}));

describe("editor wiring", () => {
  let root: string;
  let pi: any;
  let command: (args: string, ctx: any) => Promise<void>;

  const handler = (name: string) => pi.on.mock.calls.find(([event]: any[]) => event === name)![1];

  /** Create the editor the way pi does: by invoking the factory it was given. */
  function instantiateEditor(ui: any) {
    const factory = ui.setEditorComponent.mock.calls.at(-1)![0];
    expect(typeof factory).toBe("function");
    return factory({ requestRender: vi.fn() }, {}, {});
  }

  beforeEach(async () => {
    vi.resetModules();
    editors.length = 0;
    delete process.env.TEAM_ROLE;
    root = mkdtempSync(join(tmpdir(), "editor-wiring-"));
    process.env.TOP_NOTCH_TEAM_ROOT = root;

    const tools: any[] = [];
    pi = {
      registerShortcut: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((def: any) => tools.push(def)),
      on: vi.fn(),
      getAllTools: () => tools,
      getActiveTools: () => tools.map((def) => def.name),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
    };

    const extension = await import("../index");
    extension.default(pi);
    command = pi.registerCommand.mock.calls.find(([name]: any[]) => name === "team")![1].handler;
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it("switches the editor into team mode when a session starts", async () => {
    const ctx = createMockContext();
    handler("session_start")({ type: "session_start", reason: "new" }, ctx);
    await command("dynamic", ctx);

    const editor = instantiateEditor(ctx.ui as any);
    expect(editors).toHaveLength(1);
    expect(editors[0]).toBe(editor);
    expect(editor.setTeamMode).toHaveBeenCalledTimes(1);
    expect(editor.setTeamMode).toHaveBeenCalledWith(true);
  });

  it("stops the border before pi swaps back to the default editor on /team stop", async () => {
    const ctx = createMockContext();
    handler("session_start")({ type: "session_start", reason: "new" }, ctx);
    await command("dynamic", ctx);
    const editor = instantiateEditor(ctx.ui as any);
    expect(editor.setTeamMode).toHaveBeenCalledWith(true);

    editor.setTeamMode.mockClear();
    (ctx.ui.setEditorComponent as any).mockClear();

    await command("stop", ctx);

    expect(editor.setTeamMode).toHaveBeenCalledWith(false);
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(undefined);
    // Order: stop the heartbeat first, then drop the editor.
    const stoppedAt = editor.setTeamMode.mock.invocationCallOrder[0]!;
    const swappedAt = (ctx.ui.setEditorComponent as any).mock.invocationCallOrder[0]!;
    expect(stoppedAt).toBeLessThan(swappedAt);
  });

  it("stops the border on session_shutdown (/reload, /new, /resume)", async () => {
    const ctx = createMockContext();
    handler("session_start")({ type: "session_start", reason: "new" }, ctx);
    await command("dynamic", ctx);
    const editor = instantiateEditor(ctx.ui as any);

    editor.setTeamMode.mockClear();
    handler("session_shutdown")({ type: "session_shutdown", reason: "reload" });

    expect(editor.setTeamMode).toHaveBeenCalledWith(false);
  });

  it("does not switch an editor into team mode for a plain session start", async () => {
    const ctx = createMockContext();
    // No team session: the factory is still registered, but the editor stays plain.
    handler("session_start")({ type: "session_start", reason: "new" }, ctx);

    const editor = instantiateEditor(ctx.ui as any);
    expect(editor.setTeamMode).not.toHaveBeenCalled();
  });
});
