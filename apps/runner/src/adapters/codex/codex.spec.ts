import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../../config';
import { tempDir } from '../../testing/fixtures';
import { adapters } from '../index';
import { freshState } from '../types';
import { codexAdapter } from './adapter';

/** Why the parser tests below are skipped; un-skip them with a real fixture (D7). */
const NO_FIXTURE =
  'skipped: no real Codex transcript yet, Codex is not installed on the reference machine (spec 12 D7)';

const profile = (codexHome: string): ConfigProfile => ({
  id: 'codex-default',
  runtime: 'codex',
  env: { CODEX_HOME: codexHome },
  args: [],
});

describe('codex adapter (D7)', () => {
  it('is registered for its runtime', () => {
    expect(adapters.codex).toBe(codexAdapter);
    expect(codexAdapter.runtime).toBe('codex');
  });

  it('discovers transcripts at any depth under sessions/ and reports them as not parsed', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const day = join(dir, 'sessions', '2026', '10', '01');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, 'rollout-a.jsonl'), '{}\n');
      writeFileSync(join(day, 'notes.txt'), 'ignored');
      const [source, ...rest] = codexAdapter.discover(profile(dir), dir);
      expect(rest).toEqual([]);
      expect(source).toMatchObject({
        runtime: 'codex',
        sessionId: 'rollout-a',
      });

      const events: UnsequencedEvent[] = [];
      for await (const chunk of codexAdapter.tail(source, freshState(), {
        projects: [],
      })) {
        events.push(...chunk.events);
        expect(chunk.state.offset).toBe(source.size);
      }
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ parsed: false, cwd: day });
    } finally {
      cleanup();
    }
  });

  it.skip(`emits one turn per user prompt — ${NO_FIXTURE}`, () => {});
  it.skip(`emits one llm.request per request with its token buckets — ${NO_FIXTURE}`, () => {});
  it.skip(`pairs tool calls with their results — ${NO_FIXTURE}`, () => {});
  it.skip(`emits no content from the fixture's sentinel strings — ${NO_FIXTURE}`, () => {});
});
