import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../mcp/server';
import { tempDir } from '../testing/fixtures';
import {
  cardIssueNumber,
  FinishGuard,
  finishGuardArgs,
  missingArtifacts,
  parseFinishGuardArgs,
  readDescription,
} from './finish-guard';

const COMPLETE = [
  'Spec: https://github.com/o/r/blob/b/docs/specs/1.md',
  '',
  'Closes #12',
  '',
  '## What changed and why',
  '',
  'The runner wires Token saver.',
  '',
  '## Acceptance criteria',
  '',
  '- [x] it works — checked by a test',
].join('\n');

const SUMMARY = 'Wired Token saver into the launch. Checked it with the tests.';

describe('missingArtifacts (#445 D8)', () => {
  it('is empty for a complete description and summary', () => {
    expect(missingArtifacts(COMPLETE, SUMMARY, 12)).toEqual([]);
  });

  it('lists a missing `## Acceptance criteria`', () => {
    const description = COMPLETE.replace('## Acceptance criteria', '');
    expect(missingArtifacts(description, SUMMARY, 12)).toEqual([
      '`## Acceptance criteria` in .agentdock/pull-request.md',
    ]);
  });

  it('asks for `Closes #n` only when the issue is known', () => {
    const description = COMPLETE.replace('Closes #12', '');
    expect(missingArtifacts(description, SUMMARY, 12)).toEqual([
      '`Closes #12` in .agentdock/pull-request.md',
    ]);
    expect(missingArtifacts(description, SUMMARY, null)).toEqual([]);
    expect(missingArtifacts(COMPLETE, SUMMARY, 1)).toEqual([
      '`Closes #1` in .agentdock/pull-request.md',
    ]);
  });

  it('wants a summary of at least 2 sentences', () => {
    expect(missingArtifacts(COMPLETE, 'Done.', 12)).toEqual([
      'a summary of at least 2 sentences: what changed and how you checked it',
    ]);
    expect(missingArtifacts(COMPLETE, 'Fixed it. Tests pass', 12)).toEqual([]);
  });

  it('lists the file itself when there is none', () => {
    expect(missingArtifacts(null, SUMMARY, 12)).toEqual([
      '.agentdock/pull-request.md (the file is missing or empty)',
    ]);
  });
});

describe('FinishGuard (#445 D8)', () => {
  const guard = (description: string | null) =>
    new FinishGuard({
      issueNumber: 12,
      worktree: '/w',
      read: () => description,
    });

  it('accepts a complete finish at once', () => {
    expect(guard(COMPLETE).check(SUMMARY)).toEqual({
      kind: 'accept',
      artifactIncomplete: false,
    });
  });

  it('refuses twice with what is missing, then accepts as incomplete', () => {
    const g = guard(COMPLETE.replace('## Acceptance criteria', ''));
    const first = g.check(SUMMARY);
    expect(first.kind).toBe('reject');
    expect(first.kind === 'reject' && first.message).toContain(
      '## Acceptance criteria',
    );
    expect(g.check(SUMMARY).kind).toBe('reject');
    expect(g.check(SUMMARY)).toEqual({
      kind: 'accept',
      artifactIncomplete: true,
    });
  });

  it('accepts as complete when a rewrite fixed it', () => {
    let description: string | null = null;
    const g = new FinishGuard({
      issueNumber: 12,
      worktree: '/w',
      read: () => description,
    });
    expect(g.check(SUMMARY).kind).toBe('reject');
    description = COMPLETE;
    expect(g.check(SUMMARY)).toEqual({
      kind: 'accept',
      artifactIncomplete: false,
    });
  });

  it('reads the description from the worktree', () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(readDescription(dir)).toBeNull();
      mkdirSync(join(dir, '.agentdock'));
      writeFileSync(join(dir, '.agentdock', 'pull-request.md'), COMPLETE);
      expect(readDescription(dir)).toBe(COMPLETE);
    } finally {
      cleanup();
    }
  });
});

describe('the guard’s arguments', () => {
  it('round-trips through `mcp`’s argv', () => {
    expect(finishGuardArgs(12)).toEqual(['--finish-guard', '--issue', '12']);
    expect(parseFinishGuardArgs(finishGuardArgs(12))).toEqual({
      issueNumber: 12,
    });
    expect(parseFinishGuardArgs(finishGuardArgs(null))).toEqual({
      issueNumber: null,
    });
    expect(parseFinishGuardArgs([])).toBeNull();
    expect(parseFinishGuardArgs(['--finish-guard', '--issue', 'x'])).toEqual({
      issueNumber: null,
    });
  });

  it('takes the issue from the draft PR body, else the round-1 prompt', () => {
    expect(
      cardIssueNumber({
        pullRequest: { title: 'C-1: x', body: 'WIP\n\nCloses #42\n\nm' },
        prompt: 'continue',
      }),
    ).toBe(42);
    expect(cardIssueNumber({ prompt: 'Card\nGitHub issue: #7\nmore' })).toBe(7);
    expect(cardIssueNumber({ prompt: 'continue' })).toBeNull();
  });
});

describe('a guarded finish_card over MCP (#445 D8)', () => {
  const connect = async (description: string | null) => {
    const calls: Record<string, unknown>[] = [];
    const server = buildMcpServer(
      async (_method, args) => {
        calls.push(args);
        return { ok: true, data: { number: 1, finished: true } };
      },
      {
        finishGuard: new FinishGuard({
          issueNumber: 12,
          worktree: '/w',
          read: () => description,
        }),
      },
    );
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, calls };
  };

  it('refuses without `## Acceptance criteria` and relays the third as incomplete', async () => {
    const { client, calls } = await connect(
      COMPLETE.replace('## Acceptance criteria', ''),
    );
    const call = () =>
      client.callTool({ name: 'finish_card', arguments: { summary: SUMMARY } });
    const first = await call();
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first.content)).toContain('## Acceptance criteria');
    expect((await call()).isError).toBe(true);
    expect(calls).toEqual([]);
    expect((await call()).isError).toBeFalsy();
    expect(calls).toEqual([{ summary: SUMMARY, artifactIncomplete: true }]);
  });

  it('relays a complete finish unchanged', async () => {
    const { client, calls } = await connect(COMPLETE);
    await client.callTool({
      name: 'finish_card',
      arguments: { summary: SUMMARY },
    });
    expect(calls).toEqual([{ summary: SUMMARY }]);
  });
});
