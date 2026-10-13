import { describe, expect, it } from 'bun:test';
import {
  EXIT,
  LAUNCH_AGENT_LABEL,
  launchAgentPlist,
  TERMINAL_CLOSE_AS_SUCCESS,
} from './service';

const LOG = '/Users/ada/Library/Logs/agentdock-runner.log';

describe('launchAgentPlist', () => {
  const plist = launchAgentPlist(
    ['/opt/homebrew/bin/agentdock-runner', 'run'],
    LOG,
    '/opt/homebrew/bin:/usr/bin:/bin',
  );

  it('runs the daemon through the wrapper that turns 78 into a clean exit', () => {
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(
      [
        '  <array>',
        '    <string>/bin/sh</string>',
        '    <string>-c</string>',
        `    <string>&quot;$@&quot;; c=$?; [ &quot;$c&quot; -eq 78 ] &amp;&amp; exit 0; exit &quot;$c&quot;</string>`,
        '    <string>agentdock-runner</string>',
        '    <string>/opt/homebrew/bin/agentdock-runner</string>',
        '    <string>run</string>',
        '  </array>',
      ].join('\n'),
    );
  });

  it('starts at load and restarts only after an unsuccessful exit', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain(
      '<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>',
    );
  });

  it('logs stdout and stderr to one file and carries the PATH', () => {
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${LOG}`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${LOG}`);
    expect(plist).toContain(
      '<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>',
    );
  });

  it('escapes XML in arguments and leaves PATH out when there is none', () => {
    const odd = launchAgentPlist(['/Users/a&b/<runner>', 'run'], LOG);
    expect(odd).toContain('<string>/Users/a&amp;b/&lt;runner&gt;</string>');
    expect(odd).not.toContain('EnvironmentVariables');
  });
});

describe('TERMINAL_CLOSE_AS_SUCCESS', () => {
  const exitOf = (code: number): number =>
    Bun.spawnSync([
      '/bin/sh',
      '-c',
      TERMINAL_CLOSE_AS_SUCCESS,
      'agentdock-runner',
      '/bin/sh',
      '-c',
      `exit ${code}`,
    ]).exitCode;

  it('turns a terminal close into success, so launchd does not restart it', () => {
    expect(exitOf(EXIT.terminalClose)).toBe(0);
  });

  it('passes every other exit code through', () => {
    expect(exitOf(EXIT.ok)).toBe(0);
    expect(exitOf(EXIT.failure)).toBe(1);
    expect(exitOf(EXIT.usage)).toBe(2);
  });
});
