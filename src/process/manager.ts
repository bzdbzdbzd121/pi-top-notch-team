import type { MemberProcessHandle, MemberState } from "./member-process";

export interface ProcessManagerOptions {
  /** Whether to automatically restart crashed members. Default: true */
  autoRestart?: boolean;
}

export interface ProcessManager {
  listStatus(): MemberState[];
  getStatus(name: string): MemberState | null;
  stop(name: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Called when a member process exits unexpectedly. Triggers auto-restart if enabled. */
  handleExit(name: string, exitCode: number | null): void;
  /** Dynamically add a new member handle (e.g. from start_member tool). */
  addHandle(handle: MemberProcessHandle): void;
}

/**
 * Manages the lifecycle of multiple Member processes.
 */
export function createProcessManager(
  handles: MemberProcessHandle[] = [],
  options: ProcessManagerOptions = {}
): ProcessManager {
  const { autoRestart = true } = options;
  const memberMap = new Map<string, MemberProcessHandle>();

  for (const handle of handles) {
    memberMap.set(handle.name, handle);
  }

  const manager: ProcessManager = {
    listStatus(): MemberState[] {
      return Array.from(memberMap.values()).map((h) => h.getState());
    },

    getStatus(name: string): MemberState | null {
      const handle = memberMap.get(name);
      return handle ? handle.getState() : null;
    },

    async stop(name: string): Promise<void> {
      const handle = memberMap.get(name);
      if (handle) {
        await handle.stop();
      }
    },

    async stopAll(): Promise<void> {
      await Promise.all(
        Array.from(memberMap.values()).map((h) => h.stop())
      );
    },

    handleExit(name: string, _exitCode: number | null): void {
      if (!autoRestart) return;

      const handle = memberMap.get(name);
      if (handle && handle.getState().status !== "running") {
        handle.start().catch(() => {});
      }
    },

    addHandle(handle: MemberProcessHandle): void {
      memberMap.set(handle.name, handle);
    },
  };

  return manager;
}
