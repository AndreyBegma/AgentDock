import type { AttachmentView } from '@nautelle/shared';
import {
  FILES,
  useTempAttachmentsDir,
} from '../attachments/testing/attachments-e2e';
import { CardDesignHarness } from './testing/card-design-e2e';
import { designResult } from './testing/design-e2e';

useTempAttachmentsDir();

/**
 * #244 D8 everywhere (C-152): an Inbox card's design, mockup frames and
 * attachments are 404 to a viewer, as the card itself is, until the card is
 * accepted out of the Inbox.
 */
describe('Inbox card content (e2e, C-152)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  it('a viewer gets 404 on the design, mockup HTML and attachment content of an Inbox card, and 200 once accepted', async () => {
    await h.seedProfile();
    const upload = await h.author
      .send('post', `/projects/${h.projectId}/attachments`)
      .attach('file', FILES.png, 'shot.png');
    expect(upload.status).toBe(201);
    const attachment = upload.body as AttachmentView;
    const card = await h.designedCard(1);
    const claimed = await h.author.send(
      'post',
      `${h.cardPath(card.number)}/attachments`,
      { attachmentIds: [attachment.id] },
    );
    expect(claimed.status).toBe(200);
    await h.author.send('post', `${h.cardDesignBase(card.number)}/generate`);
    await h.finishCard(
      card.id,
      designResult({ taskKey: `card-${card.number}`, variant: 1 }),
    );
    const [revision] = (await h.cardDesign(card.number)).revisions;
    await h.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { column: 'inbox', source: 'captured' },
    });

    const reads = [
      h.cardDesignBase(card.number),
      `/design-revisions/${revision.id}/html`,
      `/design-revisions/${revision.id}/frames/0/html`,
      `/projects/${h.projectId}/attachments/${attachment.id}/content`,
    ];
    const statuses = async (session: typeof h.viewer) =>
      Promise.all(
        reads.map(async (path) => [path, (await session.get(path)).status]),
      );
    const all = (status: number) => reads.map((path) => [path, status]);

    expect(await statuses(h.viewer)).toEqual(all(404));
    expect(await statuses(h.author)).toEqual(all(200));

    const accepted = await h.author.send(
      'post',
      `${h.cardPath(card.number)}/accept-suggestion`,
      {},
    );
    expect(accepted.status).toBe(200);
    expect(await statuses(h.viewer)).toEqual(all(200));
  });
});
