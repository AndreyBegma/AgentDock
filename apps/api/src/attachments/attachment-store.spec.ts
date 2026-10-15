import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentDisposition } from './attachment-http';
import { FsAttachmentStore } from './attachment-store';

describe('FsAttachmentStore (#309 D2, D6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-store-'));
  const store = new FsAttachmentStore({
    dir,
    projectQuotaBytes: 1024,
    sweepEnabled: false,
  });

  it('moves a temp file to <projectId>/<id> and reads it back', async () => {
    const temp = join(await store.tempDir(), 'abc');
    writeFileSync(temp, 'bytes');
    await store.put('p1', 'a1', temp);
    expect(existsSync(join(dir, 'p1', 'a1'))).toBe(true);
    expect(existsSync(temp)).toBe(false);
    const chunks: Buffer[] = [];
    for await (const chunk of await store.open('p1', 'a1')) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('bytes');

    const listed = [];
    for await (const file of store.list()) listed.push(file);
    expect(listed.map((f) => [f.projectId, f.id])).toEqual([['p1', 'a1']]);

    await store.remove('p1', 'a1');
    await store.remove('p1', 'a1');
    await expect(store.open('p1', 'a1')).rejects.toThrow();
  });

  it('never builds a path from a key that is not a plain token', async () => {
    for (const key of ['../x', 'a/b', '..', '', 'a\\b']) {
      await expect(store.open('p1', key)).rejects.toThrow(
        /not an attachment store key/,
      );
      await expect(store.remove(key, 'a1')).rejects.toThrow(
        /not an attachment store key/,
      );
    }
  });
});

describe('contentDisposition (#309 D8)', () => {
  it('keeps the exact name in filename* and a safe ASCII fallback', () => {
    expect(contentDisposition('inline', 'Знімок "1".png')).toBe(
      `inline; filename="________1_.png"; filename*=UTF-8''${encodeURIComponent('Знімок "1".png')}`,
    );
    expect(contentDisposition('attachment', "it's (a).log")).toBe(
      `attachment; filename="it_s__a_.log"; filename*=UTF-8''it%27s%20%28a%29.log`,
    );
  });
});
