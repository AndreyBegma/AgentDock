/**
 * C-369 (ADR-0090 §3): the DemoFlow this runner records with. It is never
 * installed globally: every call goes through `npx --yes demoflow@<pin>`, so
 * a bump is a deliberate change here and a runner release.
 */
export const DEMOFLOW_VERSION = '0.4.0';
export const DEMOFLOW_PACKAGE = `demoflow@${DEMOFLOW_VERSION}`;

/** DemoFlow 0.4 needs Node 22 or later for `npx` to run it. */
export const DEMOFLOW_NODE_MAJOR = 22;

/**
 * What the pinned DemoFlow can do. `portTemplating`: `demoflow.config.json`
 * takes `${PORT}` and DemoFlow always starts a fresh app (`--fresh-app`), so
 * the runner can move the app to a free port. 0.4.0 has neither: the app runs
 * on the port its `readyUrl` names, and the runner refuses to record when
 * that port is already taken — DemoFlow would record whatever answers there.
 */
export const DEMOFLOW_FEATURES = { portTemplating: false } as const;

export interface DemoflowCommand {
  binary: 'npx';
  args: string[];
}

/** `npx --yes demoflow@<pin> <args>`: an argv, never a shell string. */
export const demoflowCommand = (...args: string[]): DemoflowCommand => ({
  binary: 'npx',
  args: ['--yes', DEMOFLOW_PACKAGE, ...args],
});

/**
 * The card session's DemoFlow MCP server as an inline `--mcp-config`: stdio,
 * through the same pinned `npx`, so the worker validates its scenario with the
 * DemoFlow that records it.
 */
export const demoflowMcpConfig = (): string => {
  const { binary, args } = demoflowCommand('mcp');
  return JSON.stringify({
    mcpServers: { demoflow: { type: 'stdio', command: binary, args } },
  });
};
