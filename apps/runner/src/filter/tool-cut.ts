/**
 * #747 D5-D8: `tool-hook`, the PostToolUse hook after the MCP, Grep and
 * WebFetch calls whose cut technique is on (`NAUTELLE_TECHNIQUES`). A result
 * over 16,000 characters becomes its head and tail around a marker that names
 * the full text's raw file.
 *
 * A fail-open stub until slot i747-cut fills it: no output is "no change",
 * so the original result reaches the model.
 *
 * On the hot path like `read-hook`: no imports beyond the filter's own.
 */

export interface ToolHookDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
}

/** The hook's stdout for one PostToolUse event; `''` leaves the result as it is. */
export const runToolHook = (_stdin: string, _deps: ToolHookDeps): string => '';
