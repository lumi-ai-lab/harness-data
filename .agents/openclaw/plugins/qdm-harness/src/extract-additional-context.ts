export function extractAdditionalContext(output: string): string {
  if (!output.trim()) return "";
  try {
    const payload = JSON.parse(output) as {
      hookSpecificOutput?: { additionalContext?: unknown };
      additionalContext?: unknown;
      context?: unknown;
    };
    const context =
      payload.hookSpecificOutput?.additionalContext ??
      payload.additionalContext ??
      payload.context;
    return typeof context === "string" ? context.trim() : "";
  } catch {
    return "";
  }
}
