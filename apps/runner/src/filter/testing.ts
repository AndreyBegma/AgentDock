import type { Filter } from './types';

/**
 * Filters for the engine's own tests. `demo-test` prints TAP-like lines;
 * the demo filter drops the passing ones and keeps everything else.
 */
export const demoFilter: Filter = {
  id: 'fixture/demo',
  matches: (argv) => argv[0] === 'demo-test' || argv[0] === 'demo.sh',
  longRunning: (argv) => argv.includes('--forever'),
  apply: ({ output }) => {
    const lines = output.split('\n');
    if (!lines.some((l) => /^(not )?ok \d+/.test(l))) return null;
    return lines.filter((l) => !/^ok \d+/.test(l)).join('\n');
  },
};

/** Drops everything — the engine must overrule it whenever a line matters. */
export const lossyFilter: Filter = {
  id: 'fixture/lossy',
  matches: (argv) => argv[0] === 'lossy',
  apply: () => 'all good\n',
};

export const throwingFilter: Filter = {
  id: 'fixture/throws',
  matches: (argv) => argv[0] === 'throws',
  apply: () => {
    throw new Error('boom');
  },
};

/** `count` passing lines, then the failures, then a summary. */
export const tapOutput = (count: number, failures: string[] = []): string => {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`ok ${i} - behaves as described in case number ${i}`);
  }
  for (const failure of failures) lines.push(failure);
  lines.push(
    `${count} passed${failures.length > 0 ? `, ${failures.length} failed` : ''}`,
  );
  return `${lines.join('\n')}\n`;
};
