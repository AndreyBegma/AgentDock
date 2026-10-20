#!/usr/bin/env node
// agentdock-runner, the name of nautelle-runner before ADR-0073. In the
// compatibility window (runner 0.14 and 0.15) this package only depends on the
// same version of nautelle-runner and runs it, so a machine that installed
// agentdock-runner keeps a runner, and anything that still calls the old
// command (a service unit, the hooks of the agentdock plugin) reaches it.

const NOTICE = [
  'agentdock-runner is deprecated: the runner is now nautelle-runner.',
  'Install it with `npm i -g nautelle-runner`, remove this package with',
  '`npm rm -g agentdock-runner`, then run `nautelle-runner install-service`',
  'and `nautelle-runner setup claude`. Runner 0.16.0 is not published as',
  'agentdock-runner.',
  '',
].join('\n');

/**
 * Whether to print the notice: only when a person reads stderr. A hook, the
 * MCP server or a filter runs under Claude Code, which owns that output.
 */
const shouldNotify = (stderr) => stderr.isTTY === true;

const main = () => {
  if (shouldNotify(process.stderr)) process.stderr.write(NOTICE);
  require('nautelle-runner/bin/nautelle-runner.js').main();
};

module.exports = { NOTICE, shouldNotify };

if (require.main === module) main();
