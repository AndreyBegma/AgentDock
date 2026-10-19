import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ATTACHMENTS_WORKTREE_DIR,
  type AttachmentRef,
  attachmentFileName,
} from '@agentdock/shared';
import { CommandFailure } from '../commands/failure';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { type AttachmentSource, syncAttachments } from './attachments';
import { ensureWorktree } from './git';
import { cardWorktreePath } from './launch';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/** #309 D9 against a real git worktree; the API is a fake `fetch`. */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const refOf = (id: string, name: string, bytes: Uint8Array): AttachmentRef => ({
  id,
  name,
  mime: 'text/plain',
  size: bytes.byteLength,
  sha256: sha(bytes),
});

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** #628: a real 3200×800 PNG, made from a 1×1 one. */
const wideScreenshot = (): Promise<Uint8Array> =>
  new Bun.Image(
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    ),
  )
    .resize(3200, 800)
    .png()
    .bytes();

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  const worktree = cardWorktreePath(f.root, 'ab12cd34');
  const deps = { exec: f.exec, tempRoot: f.ws };
  await ensureWorktree(deps, {
    root: f.root,
    worktree,
    branch: 'feat/42-export-csv',
    base: 'main',
  });
  const requests: { url: string; authorization: string | null }[] = [];
  const bodies = new Map<string, Uint8Array>();
  const responder = (status = 200): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const body = bodies.get(url.slice(url.lastIndexOf('/') + 1));
      if (status !== 200 || !body) {
        return new Response('nope', { status: status === 200 ? 404 : status });
      }
      return new Response(body, { status: 200 });
    }) as typeof fetch;
  const source = (status = 200): AttachmentSource => ({
    server: 'https://agentdock.example.test/',
    token: 'runner-token',
    fetch: responder(status),
  });
  const dir = join(worktree, ATTACHMENTS_WORKTREE_DIR);
  const failure = async (
    run: () => Promise<void>,
  ): Promise<CommandFailure | undefined> => {
    try {
      await run();
    } catch (error) {
      return error instanceof CommandFailure ? error : undefined;
    }
    return undefined;
  };
  return { f, deps, worktree, dir, requests, bodies, source, failure };
};

describe('syncAttachments', () => {
  it('downloads with the runner token, verifies and writes each file', async () => {
    const s = await setup();
    const shot = text('png-ish bytes');
    const notes = text('some notes');
    s.bodies.set('a1', shot);
    s.bodies.set('a2', notes);
    const refs = [
      refOf('a1', 'shot one.png', shot),
      refOf('a2', 'n.txt', notes),
    ];

    await syncAttachments(s.deps, s.worktree, refs, s.source());

    expect(readdirSync(s.dir).sort()).toEqual(
      refs.map((r) => attachmentFileName(r.id, r.name)).sort(),
    );
    expect(readFileSync(join(s.dir, 'a1-shot_one.png'), 'utf8')).toBe(
      'png-ish bytes',
    );
    expect(s.requests.map((r) => r.url).sort()).toEqual([
      'https://agentdock.example.test/runner/attachments/a1',
      'https://agentdock.example.test/runner/attachments/a2',
    ]);
    expect(
      s.requests.every((r) => r.authorization === 'Bearer runner-token'),
    ).toBe(true);
  });

  it('keeps .agentdock/ out of git status', async () => {
    const s = await setup();
    const bytes = text('x');
    s.bodies.set('a1', bytes);
    await syncAttachments(
      s.deps,
      s.worktree,
      [refOf('a1', 'x.txt', bytes)],
      s.source(),
    );
    await syncAttachments(
      s.deps,
      s.worktree,
      [refOf('a1', 'x.txt', bytes)],
      s.source(),
    );

    expect((await s.f.run(s.worktree, 'status', '--porcelain')).trim()).toBe(
      '',
    );
    const exclude = (
      await s.f.run(
        s.worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'info/exclude',
      )
    ).trim();
    expect(
      readFileSync(exclude, 'utf8')
        .split('\n')
        .filter((line) => line === '.agentdock/'),
    ).toHaveLength(1);
  });

  it('fails with attachments_unavailable when the bytes are tampered with', async () => {
    const s = await setup();
    const real = text('what was uploaded');
    s.bodies.set('a1', text('what the wire said'));
    const error = await s.failure(() =>
      syncAttachments(
        s.deps,
        s.worktree,
        [refOf('a1', 'x.txt', real)],
        s.source(),
      ),
    );
    expect(error?.code).toBe('attachments_unavailable');
    expect(existsSync(join(s.dir, 'a1-x.txt'))).toBe(false);
  });

  it('fails with attachments_unavailable when a body is larger than its size', async () => {
    const s = await setup();
    const real = text('short');
    s.bodies.set('a1', text('short and then a lot more'));
    const error = await s.failure(() =>
      syncAttachments(
        s.deps,
        s.worktree,
        [refOf('a1', 'x.txt', real)],
        s.source(),
      ),
    );
    expect(error?.code).toBe('attachments_unavailable');
  });

  it('fails with attachments_unavailable on an HTTP error and on a network error', async () => {
    const s = await setup();
    const bytes = text('x');
    const ref = refOf('a1', 'x.txt', bytes);
    expect(
      (
        await s.failure(() =>
          syncAttachments(s.deps, s.worktree, [ref], s.source(404)),
        )
      )?.code,
    ).toBe('attachments_unavailable');
    const offline: AttachmentSource = {
      ...s.source(),
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    };
    expect(
      (
        await s.failure(() =>
          syncAttachments(s.deps, s.worktree, [ref], offline),
        )
      )?.code,
    ).toBe('attachments_unavailable');
  });

  it('never puts the token in an error', async () => {
    const s = await setup();
    const ref = refOf('a1', 'x.txt', text('x'));
    const error = await s.failure(() =>
      syncAttachments(s.deps, s.worktree, [ref], s.source(500)),
    );
    expect(error?.message).not.toContain('runner-token');
  });

  it('fails with attachments_unavailable when the runner has no source', async () => {
    const s = await setup();
    const error = await s.failure(() =>
      syncAttachments(
        s.deps,
        s.worktree,
        [refOf('a1', 'x.txt', text('x'))],
        undefined,
      ),
    );
    expect(error?.code).toBe('attachments_unavailable');
  });

  it('prunes files that are no longer listed, and keeps a verified one without downloading it', async () => {
    const s = await setup();
    const keep = text('keep me');
    const keepRef = refOf('a1', 'keep.txt', keep);
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, attachmentFileName('a1', 'keep.txt')), keep);
    writeFileSync(join(s.dir, 'a9-removed.png'), 'old');
    writeFileSync(join(s.dir, '.tmp-a8-half.txt'), 'half');

    await syncAttachments(s.deps, s.worktree, [keepRef], s.source());

    expect(readdirSync(s.dir)).toEqual(['a1-keep.txt']);
    expect(s.requests).toHaveLength(0);
  });

  it('downloads again a file whose content no longer matches', async () => {
    const s = await setup();
    const bytes = text('the real content');
    s.bodies.set('a1', bytes);
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'a1-x.txt'), 'edited by the agent');

    await syncAttachments(
      s.deps,
      s.worktree,
      [refOf('a1', 'x.txt', bytes)],
      s.source(),
    );

    expect(readFileSync(join(s.dir, 'a1-x.txt'), 'utf8')).toBe(
      'the real content',
    );
  });

  it('empties the directory for an empty list and does nothing when there is none', async () => {
    const s = await setup();
    await syncAttachments(s.deps, s.worktree, [], undefined);
    expect(existsSync(s.dir)).toBe(false);

    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'a9-removed.png'), 'old');
    await syncAttachments(s.deps, s.worktree, [], undefined);
    expect(readdirSync(s.dir)).toEqual([]);
  });

  // #628: a plan or design turn reads an image at the size the model uses.
  it('scales an image for a model once, and keeps it across syncs', async () => {
    const s = await setup();
    const shot = await wideScreenshot();
    s.bodies.set('a1', shot);
    const refs: AttachmentRef[] = [
      { ...refOf('a1', 'shot.png', shot), mime: 'image/png' },
    ];

    await syncAttachments(s.deps, s.worktree, refs, s.source(), {
      forModel: true,
    });
    const file = join(s.dir, 'a1-shot.png');
    const meta = await new Bun.Image(readFileSync(file)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1568, 392]);
    expect(readdirSync(s.dir)).toEqual(['a1-shot.png']);

    await syncAttachments(s.deps, s.worktree, refs, s.source(), {
      forModel: true,
    });
    expect(s.requests).toHaveLength(1);
  });

  it("keeps a card worktree's image as the person attached it", async () => {
    const s = await setup();
    const shot = await wideScreenshot();
    s.bodies.set('a1', shot);
    const refs: AttachmentRef[] = [
      { ...refOf('a1', 'shot.png', shot), mime: 'image/png' },
    ];
    await syncAttachments(s.deps, s.worktree, refs, s.source());
    expect(sha(readFileSync(join(s.dir, 'a1-shot.png')))).toBe(sha(shot));
  });
});
