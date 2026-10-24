import { describe, expect, test } from 'bun:test';
import type { CardDemoView, DemoStatus } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoChip, scenarioUrl } from '../../lib/demos/format';
import { DemoChip } from './demo-chip';
import { DemoPanel } from './demo-section';

const demo = (over: Partial<CardDemoView> = {}): CardDemoView => ({
  id: 'd1',
  round: 2,
  status: 'ready',
  trigger: 'auto',
  reason: null,
  scenarioPath: 'demoflow/cards/C-7-thing.demo.json',
  attachmentId: 'a1',
  contentUrl: '/projects/p1/attachments/a1/content',
  durationMs: 42_000,
  size: 1024,
  requestedByName: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  startedAt: '2026-10-24T10:00:05.000Z',
  finishedAt: '2026-10-24T10:01:00.000Z',
  ...over,
});

const render = (
  demos: CardDemoView[],
  over: { canOperate?: boolean; accept?: boolean } = {},
) =>
  renderToStaticMarkup(
    <DemoPanel
      demos={demos}
      cardTitle="Thing"
      prUrl="https://github.com/o/r/pull/5"
      branch="card/c7-thing"
      canOperate={over.canOperate ?? true}
      accept={over.accept ? { busy: false, run: () => {} } : null}
    />,
  );

describe('Demo section states (C-371)', () => {
  test('a ready demo plays the video with round, length and the scenario link', () => {
    const html = render([demo()]);
    expect(html).toContain('<video');
    // The API's path, read through the web app's `/api` rewrite.
    expect(html).toContain('src="/api/projects/p1/attachments/a1/content"');
    expect(html).toContain('Round 2');
    expect(html).toContain('0:42');
    expect(html).toContain(
      'href="https://github.com/o/r/blob/card/c7-thing/demoflow/cards/C-7-thing.demo.json"',
    );
    expect(html).toContain('Ready');
  });

  test('a recording in flight shows Recording… and no player, and Record again is disabled', () => {
    const html = render([
      demo({ status: 'recording', attachmentId: null, contentUrl: null }),
    ]);
    expect(html).toContain('Recording…');
    expect(html).not.toContain('<video');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Record again/);
  });

  test('a failed demo says why, and Accept is still offered', () => {
    const html = render(
      [
        demo({
          status: 'failed',
          reason: 'The login step timed out.',
          contentUrl: null,
        }),
      ],
      { accept: true },
    );
    expect(html).toContain('Failed');
    expect(html).toContain('The login step timed out.');
    expect(html).toContain('Accept');
  });

  test('a skipped demo shows its reason', () => {
    const html = render([
      demo({
        status: 'skipped',
        reason: 'No UI files changed.',
        contentUrl: null,
      }),
    ]);
    expect(html).toContain('Skipped');
    expect(html).toContain('No UI files changed.');
    // Nothing was recorded, so the facts do not say it was.
    expect(html).not.toContain('Recorded');
  });

  test('Accept sits right under the video, before the facts', () => {
    const html = render([demo()], { accept: true });
    expect(html.indexOf('<video')).toBeLessThan(html.indexOf('Accept'));
    expect(html.indexOf('Accept')).toBeLessThan(html.indexOf('Round 2'));
  });

  test('earlier demos are listed with a Watch button for the ready ones', () => {
    const html = render([
      demo({ id: 'd2', round: 3 }),
      demo({ id: 'd1', round: 2 }),
      demo({ id: 'd0', round: 1, status: 'failed', contentUrl: null }),
    ]);
    expect(html).toContain('Earlier demos');
    expect(html.match(/>Watch</g)).toHaveLength(1);
  });

  test('a viewer cannot record again', () => {
    expect(render([demo()], { canOperate: false })).not.toContain(
      'Record again',
    );
  });
});

describe('demo chip and links', () => {
  const statuses: DemoStatus[] = [
    'queued',
    'recording',
    'ready',
    'failed',
    'skipped',
  ];

  test('each status has a chip label and tone', () => {
    expect(
      statuses.map((s) => demoChip({ status: s, durationMs: 65_000 })),
    ).toEqual([
      expect.objectContaining({ label: 'Recording demo', tone: 'warn' }),
      expect.objectContaining({ label: 'Recording demo', tone: 'warn' }),
      expect.objectContaining({ label: '1:05', tone: 'ok' }),
      expect.objectContaining({ label: 'Demo failed', tone: 'danger' }),
      expect.objectContaining({ label: 'Demo skipped', tone: 'neutral' }),
    ]);
  });

  test('the tile chip renders the play icon with the length when ready', () => {
    const html = renderToStaticMarkup(
      <DemoChip demo={{ status: 'ready', durationMs: 42_000 }} />,
    );
    expect(html).toContain('0:42');
    expect(html).toContain('data-demo-chip="ready"');
  });

  test('the scenario link needs a PR and a branch', () => {
    expect(scenarioUrl(null, 'b', 'demoflow/cards/C-1-x.demo.json')).toBeNull();
    expect(scenarioUrl('https://github.com/o/r/pull/1', null, 'x')).toBeNull();
  });
});
