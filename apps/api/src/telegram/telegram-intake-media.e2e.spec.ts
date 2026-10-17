import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_CARD_MAX,
  PLANNER_BLOCK_TAG,
} from '@agentdock/shared';
import {
  FILES,
  useTempAttachmentsDir,
} from '../attachments/testing/attachments-e2e';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { PlanService } from '../planner/plan.service';
import { PlannerCommands } from '../planner/planner-commands';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import { RunnerPresence } from '../runners/runner-presence';
import { MEDIA_REPLIES } from './intake-media';
import {
  SPEECH_TO_TEXT_OPTIONS,
  type SpeechToTextOptions,
} from './speech-to-text';
import {
  INTAKE_REPLIES,
  TelegramIntakeService,
} from './telegram-intake.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  type FakeCall,
  FakeTelegram,
  mediaMessage,
  privateMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

useTempAttachmentsDir();

const CHAT = 7201;
const VIEWER_CHAT = 7202;
const ROOT = '/srv/dev/widget';
const REPO = 'acme/widget';
const BRIEF = 'Fix the overlapping header';
const SPOKEN = 'Add a dark mode toggle to the settings page';

const ROUND = {
  action: 'intake',
  questions: [
    {
      id: 'scope',
      title: 'Scope',
      question: 'Which pages get the toggle?',
      options: [
        { id: 'settings', label: 'Settings only' },
        { id: 'all', label: 'Every page' },
      ],
      recommendation: {
        optionId: 'settings',
        text: 'Settings only',
        why: 'It is where people look.',
      },
      blocking: false,
    },
  ],
};

const block = (output: object): string =>
  `Here is the result.\n\n\`\`\`${PLANNER_BLOCK_TAG}\n${JSON.stringify(output)}\n\`\`\`\n`;

const photo = (fileId: string, size?: number) => ({
  photo: [
    { file_id: `${fileId}-small`, width: 90, height: 60, file_size: 10 },
    { file_id: fileId, width: 1280, height: 853, file_size: size },
  ],
});

const voice = (fileId: string) => ({
  voice: { file_id: fileId, duration: 3, mime_type: 'audio/ogg' },
});

/** An OGG page header: enough for the service to be handed audio bytes. */
const OGG = Buffer.from('OggS\0\u0002voice-bytes');

describe('Telegram /new: photos and voice messages (e2e, #594)', () => {
  let ctx: TelegramE2e;
  let fake: FakeTelegram;
  let nextUpdate = 1;
  let adaId: string;
  let projectId: string;
  let runnerId: string;
  let seq = 0;
  let stt: SpeechToTextOptions;
  /** The requests the faked speech-to-text service got. */
  let transcribed: { url: string; form: FormData; auth: string | null }[];
  let transcript = SPOKEN;

  const poller = () => ctx.app.get(TelegramPoller);
  const intake = () => ctx.app.get(TelegramIntakeService);

  const poll = async (...updates: { update_id: number }[]) => {
    const before = ctx.fake.calls.length;
    ctx.fake.updates = updates;
    await poller().pollOnce();
    await intake().idle();
    return ctx.fake.calls.slice(before);
  };
  const texts = (calls: FakeCall[]) =>
    calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
  const say = (text: string, chatId = CHAT) =>
    poll(privateMessage(nextUpdate++, chatId, text));
  const send = (
    media: Record<string, unknown>,
    caption?: string,
    replyToId?: number,
    chatId = CHAT,
  ) => poll(mediaMessage(nextUpdate++, chatId, media, caption, replyToId));

  const planOf = () =>
    ctx.prisma.plan.findFirstOrThrow({ where: { projectId, mode: 'card' } });
  const detailOf = async () =>
    ctx.app.get(PlanService).detail(projectId, adaId, (await planOf()).id);

  /** The runner reports the active turn finished with `output`. */
  const finish = async (planId: string, output: object) => {
    const turn = await ctx.prisma.planTurn.findFirstOrThrow({
      where: { planId, phase: { in: ['queued', 'running'] } },
    });
    seq += 1;
    const before = ctx.fake.calls.length;
    await ctx.app.get(RunnerEventSinks).dispatch(runnerId, [
      {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        type: 'plan_turn.finished',
        source: 'runner',
        project: { repo: REPO, root: ROOT },
        data: {
          planId,
          turnId: turn.id,
          runId: turn.runId,
          projectId,
          phase: 'succeeded',
          at: new Date().toISOString(),
          exitCode: 0,
          resultText: block(output),
          resultTruncated: false,
        },
      },
    ]);
    await intake().idle();
    return ctx.fake.calls.slice(before);
  };

  /** `/new` with the brief, then the round opened; the question's message id. */
  const openRound = async () => {
    await say(`/new ${BRIEF}`);
    const plan = await planOf();
    const calls = await finish(plan.id, ROUND);
    const question = calls.find(
      (c) =>
        c.method === 'sendMessage' &&
        String(c.body.text).includes('Which pages get the toggle'),
    );
    if (!question) throw new Error('no question message');
    return { plan, questionId: ctx.fake.calls.indexOf(question) + 1 };
  };

  beforeAll(async () => {
    fake = await FakeTelegram.start();
    ctx = await createTelegramApp(undefined, fake);
    stt = ctx.app.get<SpeechToTextOptions>(SPEECH_TO_TEXT_OPTIONS);
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });
  afterEach(() => jest.restoreAllMocks());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    await ctx.prisma.plannerInstructions.deleteMany({});
    ctx.fake.reset();
    seq = 0;
    transcribed = [];
    transcript = SPOKEN;
    // The speech-to-text call is faked: a Whisper-style JSON answer.
    stt.url = 'https://stt.example.com/v1';
    stt.apiKey = 'stt-key';
    stt.model = 'whisper-1';
    stt.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      transcribed.push({
        url: String(input),
        form: init?.body as FormData,
        auth: headers.get('authorization'),
      });
      return Response.json({ text: ` ${transcript} ` });
    };
    const root = await seedUser(ctx.prisma, 'root@example.com', 'admin');
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', root.id, { actor: SYSTEM_ACTOR });
    await ctx.prisma.notificationMatcherState.create({
      data: { id: 1, eventsCursor: 0n },
    });
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma, {
      root: ROOT,
      repo: REPO,
    }));
    const profile = await ctx.prisma.runtimeProfile.create({
      data: {
        runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { defaultProfileId: profile.id },
    });
    await ctx.prisma.plannerInstructions.create({
      data: { projectId: null, version: 1, body: 'GLOBAL INSTRUCTIONS v1' },
    });
    adaId = (
      await seedUser(ctx.prisma, 'ada@example.com', 'operator', projectId)
    ).id;
    const vic = await seedUser(
      ctx.prisma,
      'vic@example.com',
      'viewer',
      projectId,
    );
    await ctx.prisma.telegramLink.createMany({
      data: [
        { userId: adaId, chatId: BigInt(CHAT) },
        { userId: vic.id, chatId: BigInt(VIEWER_CHAT) },
      ],
    });

    const presence = ctx.app.get(RunnerPresence);
    jest.spyOn(presence, 'isConnected').mockReturnValue(true);
    jest.spyOn(presence, 'missingCommand').mockReturnValue(null);
    jest
      .spyOn(ctx.app.get(PlannerCommands), 'send')
      .mockImplementation(async (_runner, name) => {
        if (name === 'plan.turn') {
          return { status: 'ok', output: { phase: 'queued' } } as never;
        }
        return { status: 'ok', output: { removed: true } } as never;
      });
  });

  describe('photos', () => {
    it('starts a plan from a photo with /new as its caption, and the intake view lists the photo', async () => {
      fake.addFile('shot', FILES.png);
      const calls = await send(photo('shot'), `/new ${BRIEF}`);
      expect(texts(calls)).toEqual([
        'Thinking…',
        'widget · New work started. It is in the Board’s drafts too.',
      ]);
      // The largest size is the one downloaded.
      expect(fake.downloads).toEqual(['shot']);
      const detail = await detailOf();
      expect(detail.brief).toBe(BRIEF);
      expect(detail.intake?.attachments).toEqual([
        expect.objectContaining({
          name: expect.stringMatching(/^photo-\d+\.jpg$/),
          mime: 'image/png',
          size: FILES.png.length,
          uploaderId: adaId,
        }),
      ]);
      const [row] = await ctx.prisma.attachment.findMany();
      expect(row).toMatchObject({ planId: detail.id, expiresAt: null });
      // The web reads the bytes through the content route, as its author.
      expect(detail.intake?.attachments?.[0]?.contentUrl).toBe(
        `/projects/${projectId}/attachments/${row?.id}/content`,
      );
    });

    it('keeps a photo sent with a bare /new until the description comes, then the plan takes it', async () => {
      fake.addFile('shot', FILES.png);
      const asked = await send(photo('shot'), '/new');
      expect(texts(asked)).toEqual([`widget · ${MEDIA_REPLIES.photoWaiting}`]);
      expect(await ctx.prisma.plan.count()).toBe(0);
      // A second photo before the description waits with the first.
      fake.addFile('more', FILES.png);
      await send(photo('more'));
      await say(BRIEF);
      const detail = await detailOf();
      expect(detail.brief).toBe(BRIEF);
      expect(detail.intake?.attachments).toHaveLength(2);
      expect(
        (await ctx.prisma.telegramIntake.findFirstOrThrow()).attachmentIds,
      ).toEqual([]);
    });

    it('adds a photo sent during an open round to that plan', async () => {
      const { plan } = await openRound();
      fake.addFile('later', FILES.png);
      const calls = await send(photo('later'));
      expect(texts(calls)).toEqual([MEDIA_REPLIES.photoAdded]);
      const attachments = await ctx.prisma.attachment.findMany();
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toMatchObject({ planId: plan.id, cardId: null });
      expect((await detailOf()).intake?.attachments).toHaveLength(1);
    });

    it('refuses an image outside the allowlist and stores nothing', async () => {
      fake.addFile('vector', FILES.svg);
      const calls = await send(
        {
          document: {
            file_id: 'vector',
            file_name: 'logo.svg',
            mime_type: 'image/svg+xml',
          },
        },
        `/new ${BRIEF}`,
      );
      const [answer] = texts(calls);
      expect(answer).toMatch(
        /^widget · That file was not stored: Only PNG, JPEG, GIF, WebP, PDF and plain text files/,
      );
      expect(await ctx.prisma.attachment.count()).toBe(0);
      expect(await ctx.prisma.plan.count()).toBe(0);
    });

    it('refuses a file that is not an image without downloading it', async () => {
      await openRound();
      fake.addFile('report', FILES.pdf);
      const calls = await send({
        document: {
          file_id: 'report',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
        },
      });
      expect(texts(calls)).toEqual([MEDIA_REPLIES.notImage]);
      expect(fake.downloads).toEqual([]);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('refuses a photo over the size limit before downloading it, and stores nothing', async () => {
      fake.addFile('huge', FILES.png, ATTACHMENT_MAX_BYTES + 1);
      const calls = await send(photo('huge', ATTACHMENT_MAX_BYTES + 1), '/new');
      expect(texts(calls)).toEqual([`widget · ${MEDIA_REPLIES.tooLarge}`]);
      expect(fake.downloads).toEqual([]);
      expect(fake.calls.some((c) => c.method === 'getFile')).toBe(false);
      expect(await ctx.prisma.attachment.count()).toBe(0);
      expect(await ctx.prisma.telegramIntake.count()).toBe(0);
    });

    it('refuses a photo past the per-card cap', async () => {
      const { plan } = await openRound();
      jest
        .spyOn(ctx.prisma.attachment, 'count')
        .mockResolvedValueOnce(ATTACHMENTS_PER_CARD_MAX);
      fake.addFile('one-more', FILES.png);
      const calls = await send(photo('one-more'));
      expect(texts(calls)).toEqual([MEDIA_REPLIES.tooMany]);
      expect(fake.downloads).toEqual([]);
      expect(
        await ctx.prisma.attachment.count({ where: { planId: plan.id } }),
      ).toBe(0);
    });

    it('keeps the roles of /new: a viewer’s photo is refused', async () => {
      fake.addFile('shot', FILES.png);
      const calls = await send(
        photo('shot'),
        `/new ${BRIEF}`,
        undefined,
        VIEWER_CHAT,
      );
      expect(texts(calls)).toEqual([
        'Your role on this project does not allow that, so nothing changed.',
      ]);
      expect(fake.downloads).toEqual([]);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });
  });

  describe('voice, with transcription configured', () => {
    it('starts the intake from a voice message after a bare /new, showing the transcript first', async () => {
      await say('/new');
      fake.addFile('note', OGG);
      const calls = await send(voice('note'));
      expect(texts(calls)).toEqual([
        `Heard: “${SPOKEN}”`,
        'Thinking…',
        'widget · New work started. It is in the Board’s drafts too.',
      ]);
      expect((await planOf()).brief).toBe(SPOKEN);
      expect(transcribed).toHaveLength(1);
      const [request] = transcribed;
      expect(request?.url).toBe(
        'https://stt.example.com/v1/audio/transcriptions',
      );
      expect(request?.auth).toBe('Bearer stt-key');
      expect(request?.form.get('model')).toBe('whisper-1');
      const file = request?.form.get('file') as File;
      expect(file.name).toBe('voice.ogg');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(OGG);
      // The audio is never stored.
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('starts the intake from a voice message with /new as its caption', async () => {
      fake.addFile('note', OGG);
      await send(voice('note'), '/new');
      expect((await planOf()).brief).toBe(SPOKEN);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('answers a question with a voice reply to its message', async () => {
      const { questionId } = await openRound();
      transcript = 'Every page, please';
      fake.addFile('answer', OGG);
      const calls = await send(voice('answer'), undefined, questionId);
      expect(texts(calls)).toEqual([
        'Heard: “Every page, please”',
        INTAKE_REPLIES.answered,
      ]);
      const row = await ctx.prisma.telegramIntake.findFirstOrThrow();
      expect(row.answers).toEqual({ scope: { text: 'Every page, please' } });
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('says when nothing was heard, and starts nothing', async () => {
      transcript = '   ';
      await say('/new');
      fake.addFile('silence', OGG);
      const calls = await send(voice('silence'));
      expect(texts(calls)).toEqual([`widget · ${MEDIA_REPLIES.notHeard}`]);
      expect(await ctx.prisma.plan.count()).toBe(0);
    });

    it('says the transcription failed when the service refuses', async () => {
      stt.fetch = async () => new Response('nope', { status: 500 });
      await say('/new');
      fake.addFile('note', OGG);
      const calls = await send(voice('note'));
      expect(texts(calls)).toEqual([
        `widget · ${MEDIA_REPLIES.transcribeFailed}`,
      ]);
      expect(await ctx.prisma.plan.count()).toBe(0);
    });
  });

  describe('voice, with transcription not configured', () => {
    beforeEach(() => {
      stt.url = null;
    });

    it('answers that voice input is off, downloads nothing and starts nothing', async () => {
      await say('/new');
      fake.addFile('note', OGG);
      const calls = await send(voice('note'));
      expect(texts(calls)).toEqual([`widget · ${MEDIA_REPLIES.voiceOff}`]);
      expect(fake.downloads).toEqual([]);
      expect(transcribed).toEqual([]);
      expect(await ctx.prisma.plan.count()).toBe(0);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('answers the same to a voice reply to a question', async () => {
      const { questionId } = await openRound();
      fake.addFile('answer', OGG);
      const calls = await send(voice('answer'), undefined, questionId);
      expect(texts(calls)).toEqual([MEDIA_REPLIES.voiceOff]);
      expect(
        (await ctx.prisma.telegramIntake.findFirstOrThrow()).answers,
      ).toEqual({});
    });
  });
});
