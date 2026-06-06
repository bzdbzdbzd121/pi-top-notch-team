import { spawn, type ChildProcess } from "node:child_process";

export interface MemberProcessConfig {
  name: string;
  role: string;
  roleLabel: string;
  teamName: string;
  teamMembers: string[];
  memberDescription: string;
  sessionDir: string;
  sharedContextPath?: string;
  memberExtensionPath: string;
  cwd: string;
  /** Override the pi command path (for testing or custom installs). */
  piCommand?: string;
}

export type MemberStatus = "stopped" | "running" | "error";

export interface MemberState {
  name: string;
  pid: number | null;
  status: MemberStatus;
}

export interface MemberProcessHandle {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): MemberState;
  onEvent(handler: (event: any) => void): void;
  sendCommand(command: object): void;
  /** Send a command and wait for a matching response event. */
  sendCommandAndWait(
    command: object,
    matchFn: (event: any) => boolean,
    timeoutMs?: number
  ): Promise<any>;
}

/**
 * Wraps a single Member's pi --mode rpc subprocess.
 */
export function createMemberProcess(
  config: MemberProcessConfig,
  spawnFn: typeof spawn = spawn
): MemberProcessHandle {
  const {
    name,
    role,
    roleLabel,
    teamName,
    teamMembers,
    memberDescription,
    sessionDir,
    sharedContextPath,
    memberExtensionPath,
    cwd,
    piCommand = "pi",
  } = config;

  let child: ChildProcess | null = null;
  let status: MemberStatus = "stopped";
  let pid: number | null = null;
  const eventHandlers: Array<(event: any) => void> = [];

  function notifyHandlers(event: any) {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow handler errors
      }
    }
  }

  const handle: MemberProcessHandle = {
    get name() {
      return name;
    },

    getState(): MemberState {
      return { name, pid, status };
    },

    onEvent(handler: (event: any) => void) {
      eventHandlers.push(handler);
    },

    sendCommand(command: object) {
      if (!child || !child.stdin || child.stdin.destroyed) {
        throw new Error(`Member "${name}" is not running`);
      }
      child.stdin.write(JSON.stringify(command) + "\n");
    },

    sendCommandAndWait(
      command: object,
      matchFn: (event: any) => boolean,
      timeoutMs: number = 15000
    ): Promise<any> {
      if (!child || status !== "running") {
        return Promise.reject(new Error(`Member "${name}" is not running`));
      }

      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cmd = { ...command, id };

      // Write command
      child.stdin!.write(JSON.stringify(cmd) + "\n");

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Command to "${name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        function handler(event: any) {
          if (event.type === "response" && event.id === id && matchFn(event)) {
            cleanup();
            resolve(event);
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          const idx = eventHandlers.indexOf(handler);
          if (idx >= 0) eventHandlers.splice(idx, 1);
        }

        eventHandlers.push(handler);
      });
    },

    async start(): Promise<void> {
      if (status === "running") {
        return;
      }

      const env: Record<string, string> = {
        TEAM_ROLE: role,
        TEAM_ROLE_LABEL: roleLabel,
        TEAM_NAME: teamName,
        TEAM_MEMBERS: teamMembers.join(","),
        TEAM_MEMBER_DESCRIPTION: memberDescription,
      };

      if (sharedContextPath) {
        env.TEAM_SHARED_CONTEXT_PATH = sharedContextPath;
      }

      try {
        child = spawnFn(piCommand, [
          "--mode", "rpc",
          "--session-dir", sessionDir,
          "-e", memberExtensionPath,
          "--no-session", "false",
        ], {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        status = "error";
        pid = null;
        child = null;
        throw new Error(
          `Failed to spawn pi for member "${name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }

      pid = child.pid ?? null;
      status = "running";

      // Parse JSONL from stdout
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            notifyHandlers(event);
          } catch {
            // Not valid JSON, skip
          }
        }
      });

      child.on("exit", (_code, _signal) => {
        status = "stopped";
        pid = null;
      });

      child.on("error", () => {
        status = "error";
        pid = null;
      });
    },

    async stop(): Promise<void> {
      if (!child || status !== "running") {
        status = "stopped";
        return;
      }

      // SIGTERM first
      child.kill("SIGTERM");

      // Wait briefly for graceful exit, then SIGKILL
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child && !child.killed) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 3000);

        child!.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      status = "stopped";
      pid = null;
      child = null;
    },
  };

  return handle;
}
