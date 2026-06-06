import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Create a mock ExtensionContext for testing command handlers and tools.
 */
export function createMockContext(overrides?: Partial<ExtensionContext>): ExtensionContext {
  const uiApi: ExtensionUIContext = {
    notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue(""),
    editor: vi.fn().mockResolvedValue(""),
    custom: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setTitle: vi.fn(),
    setEditorText: vi.fn(),
    setFooter: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWorkingVisible: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setEditorComponent: vi.fn(),
    getEditorText: vi.fn().mockReturnValue(""),
    getEditorComponent: vi.fn(),
    pasteToEditor: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    getAllThemes: vi.fn().mockReturnValue([]),
    getTheme: vi.fn(),
    setTheme: vi.fn().mockResolvedValue({ success: true }),
    onTerminalInput: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setHeader: vi.fn(),
    theme: undefined!,
    getToolsExpanded: vi.fn().mockReturnValue(false),
    setToolsExpanded: vi.fn(),
  };

  const ctx: ExtensionContext = {
    mode: "tui",
    hasUI: true,
    cwd: "/test/project",
    ui: uiApi,
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getBranch: vi.fn().mockReturnValue([]),
      getLeafId: vi.fn().mockReturnValue("leaf-1"),
    } as unknown as ExtensionContext["sessionManager"],
    modelRegistry: {} as any,
    model: undefined,
    signal: undefined as any,
    isIdle: vi.fn().mockReturnValue(true),
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn().mockReturnValue(undefined),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue(""),
    ...overrides,
  };

  return ctx;
}

/**
 * Create a mock ExtensionAPI for testing.
 */
export function createMockExtensionAPI(
  overrides?: Partial<ExtensionAPI>
): ExtensionAPI {
  const handlers: Map<string, (...args: any[]) => any> = new Map();
  const tools: Map<string, any> = new Map();

  const api: ExtensionAPI = {
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((def: any) => {
      tools.set(def.name, def);
    }),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn().mockReturnValue(undefined),
    setLabel: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("off"),
    setThinkingLevel: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
    events: { on: vi.fn(), emit: vi.fn() } as any,
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    ...overrides,
  };

  return api;
}
