import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";

/** Maximum allowed serialized command size in bytes (1 MB). */
export const MAX_COMMAND_SIZE = 1024 * 1024;

/**
 * Check whether a member session dir already contains a persisted pi session
 * (`*.jsonl`, possibly nested one level in pi's per-cwd subdirectory). Used to
 * decide whether `--continue` is safe: with no prior session file pi's
 * continueRecent would have nothing to resume and the member would exit.
 */
export function hasSessionFiles(sessionDir: string): boolean {
  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true, recursive: true });
    return entries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/** Maximum number of pending writes before dropping oldest entries (OOM guard). */
export const MAX_PENDING_WRITES = 1000;

/** Compute the UTF-8 byte length of a string. */
function utf8ByteLength(str: string): number {
  return Buffer.byteLength(str, "utf-8");
}

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
  /** Model override passed to pi via `--model provider/id` (e.g. "anthropic/claude-sonnet-4-5"). */
  model?: string;
  /** Override the pi command path (for testing or custom installs). */
  piCommand?: string;
  /**
   * Resume the member's previous pi session (`--continue`) instead of starting
   * fresh. Used by /team resume and by crash auto-restart so member context
   * survives process death. Only honored when persisted session files exist.
   */
  resume?: boolean;
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
    model,
    piCommand = "pi",
  } = config;

  let child: ChildProcess | null = null;
  let status: MemberStatus = "stopped";
  let pid: number | null = null;
  let startingInProgress = false;
  // Becomes true after the first successful start. Subsequent (re)starts then
  // resume the persisted session so a crash auto-restart does not lose context.
  let startedOnce = false;
  const eventHandlers: Array<(event: any) => void> = [];

  // Write queue for handling backpressure (drain event)
  let pendingWrites: string[] = [];
  let drainPending = false;

  function enqueueWrite(data: string): void {
    if (pendingWrites.length >= MAX_PENDING_WRITES) {
      pendingWrites.shift();
      console.warn(
        `[top-notch-team] pendingWrites for ${name} overflow: dropped 1 entry (${pendingWrites.length} remaining)`
      );
    }
    pendingWrites.push(data);
  }

  function writeOrQueue(data: string): void {
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error(`Member "${name}" is not running`);
    }

    const ok = child.stdin.write(data);
    if (!ok) {
      enqueueWrite(data);
      if (!drainPending) {
        drainPending = true;
        child.stdin.once("drain", () => {
          drainPending = false;
          flushPendingWrites();
        });
      }
    }
  }

  function flushPendingWrites(): void {
    if (!child || !child.stdin || child.stdin.destroyed) {
      pendingWrites = [];
      drainPending = false;
      return;
    }

    while (pendingWrites.length > 0) {
      const data = pendingWrites[0];
      const ok = child.stdin.write(data);
      if (ok) {
        pendingWrites.shift();
      } else {
        drainPending = true;
        child.stdin.once("drain", () => {
          drainPending = false;
          flushPendingWrites();
        });
        break;
      }
    }
  }

  function assertCommandSize(command: object): void {
    const json = JSON.stringify(command);
    const byteLen = utf8ByteLength(json);
    if (byteLen > MAX_COMMAND_SIZE) {
      throw new Error(
        `Command to member "${name}" exceeds MAX_COMMAND_SIZE (${byteLen} > ${MAX_COMMAND_SIZE} bytes)`
      );
    }
  }

  function notifyHandlers(event: any) {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.warn(`[team] Handler error for event ${event.type}:`, err);
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
      assertCommandSize(command);
      writeOrQueue(JSON.stringify(command) + "\n");
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

      // Validate command size
      try {
        assertCommandSize(cmd);
      } catch (err) {
        return Promise.reject(err);
      }

      const data = JSON.stringify(cmd) + "\n";

      return new Promise((resolve, reject) => {
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Command to "${name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        function handler(event: any) {
          if (settled) return;
          try {
            if (event.type === "response" && event.id === id && matchFn(event)) {
              settled = true;
              cleanup();
              resolve(event);
            }
          } catch (err) {
            settled = true;
            cleanup();
            reject(err);
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          const idx = eventHandlers.indexOf(handler);
          if (idx >= 0) eventHandlers.splice(idx, 1);
        }

        eventHandlers.push(handler);

        // Write command (with drain handling)
        try {
          writeOrQueue(data);
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
          // If already settled, cleanup is still safe to call (idempotent)
        }
      });
    },

    async start(): Promise<void> {
      if (status === "running" || startingInProgress) {
        return;
      }
      startingInProgress = true;

      try {
        // Reset write queue from any previous session
        pendingWrites = [];
        drainPending = false;

      const env: Record<string, string> = {
        TEAM_ROLE: role,
        TEAM_ROLE_LABEL: roleLabel,
        TEAM_NAME: teamName,
        TEAM_MEMBERS: JSON.stringify(teamMembers),
        TEAM_MEMBER_DESCRIPTION: memberDescription,
      };

      if (sharedContextPath) {
        env.TEAM_SHARED_CONTEXT_PATH = sharedContextPath;
      }

      let resolveReady: () => void;
      let rejectReady: (err: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      try {
        // NOTE: never pass `--no-session` here — member sessions MUST persist
        // (append-only .jsonl under sessionDir) so they survive crashes and can
        // be resumed via `--continue`.
        const args = [
          "--mode", "rpc",
          "--session-dir", sessionDir,
          "-e", memberExtensionPath,
        ];
        // Resume the persisted session when explicitly requested (/team resume)
        // or when this handle has run before (crash auto-restart). Guarded by
        // hasSessionFiles: with no prior .jsonl, --continue would find nothing
        // and pi would exit immediately.
        if ((config.resume || startedOnce) && hasSessionFiles(sessionDir)) {
          args.push("--continue");
        }
        if (model) {
          args.push("--model", model);
        }
        child = spawnFn(piCommand, args, {
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
      let readyResolved = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            // Resolve ready promise on first valid JSON event (indicates RPC is up)
            if (!readyResolved) {
              readyResolved = true;
              resolveReady();
            }
            notifyHandlers(event);
          } catch {
            // Not valid JSON, skip (only log first few for debugging)
            if (trimmed.length < 200 && !trimmed.startsWith("{")) {
              console.warn(`[member:${name}] Non-JSON output from pi RPC: ${trimmed.slice(0, 100)}`);
            }
          }
        }
      });

      child.on("exit", (code, _signal) => {
        const wasRunning = status === "running";
        status = "stopped";
        pid = null;
        // Reject ready promise if process exited before becoming ready
        if (!readyResolved) {
          readyResolved = true;
          rejectReady(new Error(`Member "${name}" process exited (code: ${code}) before RPC was ready`));
        }
        // Notify handlers so the manager can trigger auto-restart
        notifyHandlers({
          type: "process_exit",
          memberName: name,
          exitCode: code,
          wasRunning,
        });
      });

      child.on("error", () => {
        const wasRunning = status === "running";
        status = "error";
        pid = null;
        if (!readyResolved) {
          readyResolved = true;
          rejectReady(new Error(`Failed to start member "${name}"`));
        }
        notifyHandlers({
          type: "process_error",
          memberName: name,
          wasRunning,
        });
      });

      // Wait for RPC process to be ready (first JSON line on stdout)
      await readyPromise;
      // Mark after a successful start so later restarts resume the session.
      startedOnce = true;
      } finally {
        startingInProgress = false;
      }
    },

    async stop(): Promise<void> {
      // If start is in progress, wait for it to complete before stopping
      if (startingInProgress) {
        console.warn(
          `[top-notch-team] stop() called while "${name}" is starting, waiting...`
        );
        while (startingInProgress) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      if (!child || status !== "running") {
        status = "stopped";
        return;
      }

      // Mark as stopped BEFORE sending the signal, so the exit handler
      // sees wasRunning=false and correctly distinguishes intentional
      // stop from a crash.
      status = "stopped";

      // 1. Register exit listener BEFORE sending the signal
      const exitPromise = new Promise<void>((resolve) => {
        child!.on("exit", () => resolve());
      });

      // 2. Then send SIGTERM
      child.kill("SIGTERM");

      // 3. Race: wait for graceful exit or timeout → SIGKILL
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (child && !child.killed) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 3000);
        }),
      ]);

      pid = null;
      child = null;
    },
  };

  return handle;
}
