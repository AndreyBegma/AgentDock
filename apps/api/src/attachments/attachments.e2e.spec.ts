import { createHash } from 'node:crypto';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ATTACHMENT_PENDING_TTL_MS,
  type AttachmentView,
  type BoardCardDetail,
  type BoardView,
} from '@nautelle/shared';
import { BoardWorld } from '../board/testing/board-e2e';
import {
  generateRunnerToken,
  hashRunnerToken,
  tokenPrefix,
} from '../runners/credentials';
import {
  ATTACHMENTS_OPTIONS,
  type AttachmentsOptions,
} from './attachments-options';
import { AttachmentsSweep } from './attachments-sweep';
import {
  FILES,
  upload,
  uploaded,
  useTempAttachmentsDir,
} from './testing/attachments-e2e';

const DIR = useTempAttachmentsDir();

// #156: an upload is scanned while it streams; the spy proves it is never
// read back whole.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

describe('attachments (e2e, #309)', () => {
  const w = new BoardWorld();
  let options: AttachmentsOptions;
  let quota: number;
  let pendingCap: number;

  beforeAll(async () => {
    await w.init();
    options = w.ctx.app.get(ATTACHMENTS_OPTIONS);
    quota = options.projectQuotaBytes;
    pendingCap = options.userPendingBytes;
  });
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(async () => {
    options.projectQuotaBytes = quota;
    options.userPendingBytes = pendingCap;
    await w.work.settled();
  });

  const fileOf = (id: string, projectId = w.a) => join(DIR, projectId, id);
  const content = (id: string, session = w.operator, projectId = w.a) =>
    session.get(`${w.path(projectId)}/attachments/${id}/content`);
  const remove = (id: string, session = w.operator) =>
    session.send('delete', `${w.path()}/attachments/${id}`);
  const claim = (
    number: number,
    attachmentIds: string[],
    session = w.operator,
  ) =>
    session.send('post', `${w.path()}/board/cards/${number}/attachments`, {
      attachmentIds,
    });
  const detail = async (number: number) =>
    (await w.operator.get(`${w.path()}/board/cards/${number}`))
      .body as BoardCardDetail;

  describe('uploads', () => {
    it('stores a PNG pending, by its content, with an audit record', async () => {
      const view = await uploaded(w, 'Screenshot 2026-10-15.png');
      expect(view).toMatchObject({
        name: 'Screenshot 2026-10-15.png',
        mime: 'image/png',
        size: FILES.png.length,
        roundId: null,
        uploaderId: w.operatorId,
        uploaderName: 'op@x.test',
        contentUrl: `/projects/${w.a}/attachments/${view.id}/content`,
      });
      const row = await w.ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row.cardId).toBeNull();
      expect(row.expiresAt?.getTime()).toBeGreaterThan(
        Date.now() + ATTACHMENT_PENDING_TTL_MS - 60_000,
      );
      expect(existsSync(fileOf(view.id))).toBe(true);
      const [record] = await w.audit('attachment.added');
      expect(record).toMatchObject({
        projectId: w.a,
        after: { name: view.name, mime: 'image/png', size: FILES.png.length },
      });
    });

    it('stores a PNG renamed .txt as image/png and keeps a UTF-8 name', async () => {
      expect((await uploaded(w, 'notes.txt')).mime).toBe('image/png');
      expect((await uploaded(w, 'Знімок екрана.png')).name).toBe(
        'Знімок екрана.png',
      );
    });

    it('refuses a file over 25 MiB with too_large and keeps nothing', async () => {
      const big = Buffer.alloc(26 * 1024 * 1024, 0x61);
      const response = await upload(w, 'big.txt', big);
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        error: 'attachment_error',
        code: 'too_large',
      });
      expect(await w.ctx.prisma.attachment.count()).toBe(0);
    });

    it('refuses SVG, HTML, ZIP and a binary renamed .txt with unsupported_type', async () => {
      for (const [name, file] of [
        ['logo.svg', FILES.svg],
        ['page.html', FILES.html],
        ['bundle.zip', FILES.zip],
        ['notes.txt', FILES.elf],
      ] as const) {
        const response = await upload(w, name, file);
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('unsupported_type');
      }
      expect(await w.ctx.prisma.attachment.count()).toBe(0);
    });

    it('refuses an upload past the project quota with quota_exceeded', async () => {
      options.projectQuotaBytes = FILES.png.length * 2;
      await uploaded(w);
      await uploaded(w);
      const response = await upload(w, 'third.png');
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('quota_exceeded');
    });

    it('never reads an upload whole into memory, and stores its hash', async () => {
      const read = jest.mocked(readFile);
      read.mockClear();
      const big = Buffer.alloc(5 * 1024 * 1024, 0x61);
      const view = await uploaded(w, 'big.log', big);
      expect(view).toMatchObject({ mime: 'text/plain', size: big.length });
      const uploadReads = read.mock.calls.filter(([path]) =>
        String(path).startsWith(DIR),
      );
      expect(uploadReads).toEqual([]);
      const row = await w.ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row.sha256).toBe(createHash('sha256').update(big).digest('hex'));
    });

    it("refuses with 413 pending_exceeded past the user's pending cap; others still upload", async () => {
      options.userPendingBytes = FILES.png.length * 2;
      const first = await uploaded(w);
      await uploaded(w);

      const refused = await upload(w, 'third.png');
      expect(refused.status).toBe(413);
      expect(refused.body).toMatchObject({
        error: 'attachment_error',
        code: 'pending_exceeded',
      });
      expect(
        await w.ctx.prisma.attachment.count({
          where: { uploaderId: w.operatorId },
        }),
      ).toBe(2);

      // Another member of the same project is not held by this one's uploads.
      await uploaded(w, 'admin.png', FILES.png, w.admin);

      // A claimed upload no longer counts as pending.
      await w.createCard({ attachmentIds: [first.id] });
      await uploaded(w, 'fourth.png');
    });

    it('is 400 without the file field', async () => {
      const response = await w.operator
        .send('post', `${w.path()}/attachments`)
        .field('other', 'x');
      expect(response.status).toBe(400);
    });
  });

  describe('authorization and serving', () => {
    it('serves a member, 404 to a non-member, 403 to a viewer on upload and delete', async () => {
      const a = await uploaded(w);
      await w.createCard({ attachmentIds: [a.id] });
      expect((await content(a.id, w.viewer)).status).toBe(200);
      expect((await content(a.id, w.outsider)).status).toBe(404);
      expect((await content(a.id, w.operatorOfB, w.a)).status).toBe(404);
      expect((await upload(w, 'x.png', FILES.png, w.viewer)).status).toBe(403);
      expect((await remove(a.id, w.viewer)).status).toBe(403);
    });

    it("keeps a pending upload its uploader's", async () => {
      const a = await uploaded(w);
      expect((await content(a.id)).status).toBe(200);
      expect((await content(a.id, w.viewer)).status).toBe(404);
    });

    it("lets an operator delete their own, not another user's; an admin deletes anyone's", async () => {
      const mine = await uploaded(w);
      const admins = await uploaded(w, 'a.png', FILES.png, w.admin);
      await w.createCard({ attachmentIds: [mine.id] });
      await w.createCard({ attachmentIds: [admins.id] }, w.admin);

      expect((await remove(admins.id)).status).toBe(403);
      expect((await remove(mine.id, w.admin)).status).toBe(204);
      expect(existsSync(fileOf(mine.id))).toBe(false);
      expect(
        await w.ctx.prisma.attachment.count({ where: { id: mine.id } }),
      ).toBe(0);
      const [record] = await w.audit('attachment.removed');
      expect(record.before).toMatchObject({ name: mine.name });
      expect((await remove(admins.id, w.admin)).status).toBe(204);
    });

    it('serves raster images inline and the rest as a sandboxed download, all with nosniff', async () => {
      const png = await uploaded(w, 'shot.png', FILES.png);
      const pdf = await uploaded(w, 'spec.pdf', FILES.pdf);
      const text = await uploaded(w, 'trace.log', FILES.text);

      const image = await content(png.id);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.headers['x-content-type-options']).toBe('nosniff');
      expect(image.headers['cache-control']).toBe('private, max-age=0');
      expect(image.headers['content-disposition']).toMatch(/^inline;/);
      expect(Buffer.from(image.body as Buffer).equals(FILES.png)).toBe(true);

      for (const id of [pdf.id, text.id]) {
        const response = await content(id);
        expect(response.status).toBe(200);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-disposition']).toMatch(/^attachment;/);
        expect(response.headers['content-security-policy']).toBe('sandbox');
      }
    });

    it('answers one Range with 206 and Content-Range, past the end with 416 (ADR-0090)', async () => {
      const text = await uploaded(w, 'trace.log', FILES.text);
      const whole = await content(text.id);
      expect(whole.status).toBe(200);
      expect(whole.headers['accept-ranges']).toBe('bytes');

      const part = await content(text.id).set('Range', 'bytes=2-5');
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe(
        `bytes 2-5/${FILES.text.length}`,
      );
      expect(part.headers['content-length']).toBe('4');
      expect(part.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(part.body as Buffer).toString()).toBe(
        FILES.text.subarray(2, 6).toString(),
      );

      const tail = await content(text.id).set('Range', 'bytes=-3');
      expect(tail.status).toBe(206);
      expect(tail.headers['content-range']).toBe(
        `bytes ${FILES.text.length - 3}-${FILES.text.length - 1}/${FILES.text.length}`,
      );

      const past = await content(text.id).set('Range', 'bytes=1000-');
      expect(past.status).toBe(416);
      expect(past.headers['content-range']).toBe(
        `bytes */${FILES.text.length}`,
      );
      // Still the member check first: a non-member gets no range of it.
      expect(
        (await content(text.id, w.outsider).set('Range', 'bytes=0-1')).status,
      ).toBe(404);
    });
  });

  describe('videos (ADR-0090)', () => {
    it('stores an MP4 and a WebM by their content, whatever the name', async () => {
      const mp4 = await uploaded(w, 'clip.bin', FILES.mp4);
      expect(mp4.mime).toBe('video/mp4');
      const webm = await uploaded(w, 'clip.txt', FILES.webm);
      expect(webm.mime).toBe('video/webm');

      const served = await content(mp4.id).set('Range', 'bytes=0-7');
      expect(served.status).toBe(206);
      expect(served.headers['content-type']).toBe('video/mp4');
      expect(
        Buffer.from(served.body as Buffer).equals(FILES.mp4.subarray(0, 8)),
      ).toBe(true);
    });

    it('refuses a QuickTime file, which is ftyp too, with unsupported_type', async () => {
      const response = await upload(w, 'clip.mov', FILES.mov);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('unsupported_type');
    });

    it('takes a video over 25 MiB, which another file may not be', async () => {
      const big = Buffer.concat([
        FILES.mp4,
        Buffer.alloc(26 * 1024 * 1024, 0x00),
      ]);
      const view = await uploaded(w, 'demo.mp4', big);
      expect(view).toMatchObject({ mime: 'video/mp4', size: big.length });
    });

    it('does not count a video toward the 20 attachments of a card', async () => {
      await w.createCard();
      const twenty: AttachmentView[] = [];
      for (let i = 0; i < 20; i += 1)
        twenty.push(await uploaded(w, `${i}.png`));
      expect(
        (
          await claim(
            1,
            twenty.map((a) => a.id),
          )
        ).status,
      ).toBe(200);
      const video = await uploaded(w, 'demo.mp4', FILES.mp4);
      const claimed = await claim(1, [video.id]);
      expect(claimed.status).toBe(200);
      expect((claimed.body as BoardCardDetail).attachments).toHaveLength(21);
    });
  });

  describe('the runner', () => {
    const tokenFor = async (runnerId: string): Promise<string> => {
      const token = generateRunnerToken();
      await w.ctx.prisma.runner.update({
        where: { id: runnerId },
        data: {
          tokenPrefix: tokenPrefix(token),
          tokenHash: await hashRunnerToken(token),
        },
      });
      return token;
    };
    const fetch = (id: string, token?: string) => {
      const req = w.ctx.http().get(`/runner/attachments/${id}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    it("gives the bytes to the project's runner, 404 to another runner, 401 without a token", async () => {
      const a = await uploaded(w);
      await w.createCard({ attachmentIds: [a.id] });
      const own = await tokenFor(w.runnerId);
      const other = await tokenFor(
        (await w.ctx.prisma.runner.create({ data: { name: 'laptop' } })).id,
      );

      expect((await fetch(a.id)).status).toBe(401);
      expect((await fetch(a.id, generateRunnerToken())).status).toBe(401);
      expect((await fetch(a.id, other)).status).toBe(404);
      const response = await fetch(a.id, own);
      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(response.body as Buffer).equals(FILES.png)).toBe(true);
    });

    it('does not serve a pending upload', async () => {
      const a = await uploaded(w);
      expect((await fetch(a.id, await tokenFor(w.runnerId))).status).toBe(404);
    });
  });

  describe('claiming', () => {
    it('claims on create: the card lists them, the board counts them, the audit records it', async () => {
      const a = await uploaded(w, 'one.png');
      const b = await uploaded(w, 'two.log', FILES.text);
      const card = await w.createCard({ attachmentIds: [a.id, b.id] });

      const rows = await w.ctx.prisma.attachment.findMany({
        where: { id: { in: [a.id, b.id] } },
      });
      expect(
        rows.every((r) => r.cardId === card.id && r.expiresAt === null),
      ).toBe(true);
      expect((await detail(1)).attachments.map((x) => x.id)).toEqual([
        a.id,
        b.id,
      ]);
      const board = (await w.operator.get(`${w.path()}/board`))
        .body as BoardView;
      const face = board.columns
        .flatMap((c) => c.cards)
        .find((c) => c.number === 1);
      expect(face?.attachmentCount).toBe(2);
      const [record] = await w.audit('attachment.claimed');
      expect(record.after).toMatchObject({
        cardId: card.id,
        attachmentIds: [a.id, b.id],
      });
    });

    it("refuses an id of another project, or another user's pending upload, with not_claimable — and creates no card", async () => {
      const ofB = await uploaded(w, 'b.png', FILES.png, w.operatorOfB, w.b);
      const admins = await uploaded(w, 'a.png', FILES.png, w.admin);
      for (const id of [ofB.id, admins.id, 'no-such-id']) {
        const response = await w.operator.send(
          'post',
          `${w.path()}/board/cards`,
          { title: 'x', attachmentIds: [id] },
        );
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({
          error: 'attachment_error',
          code: 'not_claimable',
        });
      }
      expect(await w.ctx.prisma.boardCard.count()).toBe(0);
    });

    it('claims onto an existing card, and refuses a 21st with too_many', async () => {
      await w.createCard();
      const twenty: AttachmentView[] = [];
      for (let i = 0; i < 20; i += 1)
        twenty.push(await uploaded(w, `${i}.png`));
      const claimed = await claim(
        1,
        twenty.map((a) => a.id),
      );
      expect(claimed.status).toBe(200);
      expect((claimed.body as BoardCardDetail).attachments).toHaveLength(20);

      const extra = await uploaded(w, '21.png');
      const refused = await claim(1, [extra.id]);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('too_many');
    });

    it('refuses a claim twice, and is 400 for an id that is a path', async () => {
      const a = await uploaded(w);
      await w.createCard({ attachmentIds: [a.id] });
      await w.createCard();
      expect((await claim(2, [a.id])).body.code).toBe('not_claimable');
      expect((await claim(2, ['../etc'])).status).toBe(400);
    });

    it('keeps the attachments of a completed card', async () => {
      const a = await uploaded(w);
      const card = await w.createCard({ attachmentIds: [a.id] });
      await w.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: { column: 'completed', completedAt: new Date() },
      });
      const response = await remove(a.id);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('card_completed');
      const later = await uploaded(w);
      expect((await claim(1, [later.id])).body.error).toBe('card_completed');
    });
  });

  describe('cleanup', () => {
    it('sweeps an expired pending upload with its file, an orphan file and a stale temp file', async () => {
      const sweep = w.ctx.app.get(AttachmentsSweep);
      const fresh = await uploaded(w, 'fresh.png');
      const old = await uploaded(w, 'old.png');
      await w.ctx.prisma.attachment.update({
        where: { id: old.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const orphan = fileOf('orphan1');
      writeFileSync(orphan, 'x');
      utimesSync(orphan, hourAgo, hourAgo);
      const young = fileOf('orphan2');
      writeFileSync(young, 'x');
      await mkdir(join(DIR, 'tmp'), { recursive: true });
      const temp = join(DIR, 'tmp', 'deadbeef');
      writeFileSync(temp, 'x');
      utimesSync(temp, hourAgo, hourAgo);

      expect(await sweep.sweep()).toEqual({ expired: 1, orphans: 1, temps: 1 });
      expect(existsSync(fileOf(old.id))).toBe(false);
      expect(
        await w.ctx.prisma.attachment.count({ where: { id: old.id } }),
      ).toBe(0);
      expect(existsSync(fileOf(fresh.id))).toBe(true);
      expect(existsSync(orphan)).toBe(false);
      // Younger than the grace: an upload may still be committing.
      expect(existsSync(young)).toBe(true);
      expect(existsSync(temp)).toBe(false);
    });

    it('deleting a card removes its attachment rows and files', async () => {
      const a = await uploaded(w);
      await w.createCard({ attachmentIds: [a.id] });
      expect(
        (await w.operator.send('delete', `${w.path()}/board/cards/1`)).status,
      ).toBe(204);
      expect(await w.ctx.prisma.attachment.count()).toBe(0);
      expect(existsSync(fileOf(a.id))).toBe(false);
    });

    it('a content purge leaves attachments in place', async () => {
      const a = await uploaded(w);
      await w.createCard({ attachmentIds: [a.id] });
      expect(
        (await w.admin.send('delete', `${w.path()}/session-content`)).status,
      ).toBe(204);
      expect(await w.ctx.prisma.attachment.count()).toBe(1);
      expect(existsSync(fileOf(a.id))).toBe(true);
    });
  });
});
