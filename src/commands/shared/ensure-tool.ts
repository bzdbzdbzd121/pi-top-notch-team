import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Check if a tool is already registered; if not, call the registration function.
 * Eliminates the repetitive `getAllTools` + `find` pattern.
 */
export function ensureToolRegistered(
  pi: ExtensionAPI,
  toolName: string,
  registrationFn: () => void,
): void {
  const allTools = ((pi as any).getAllTools?.() ?? []) as Array<{ name: string }>;
  if (!allTools.find((t) => t.name === toolName)) {
    registrationFn();
  }
}
