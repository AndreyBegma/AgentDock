import { BadRequestException, type Type, ValidationPipe } from '@nestjs/common';
import { ConfirmSplitDto, UpdatePlanCandidateDto } from './dto';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const validate = <T>(dto: Type<T>, value: unknown): Promise<T> =>
  pipe.transform(value, { type: 'body', metatype: dto });

const split = (title: string, stack?: { title: string; stage: string }) => ({
  turnId: 'turn-1',
  cards: [{ index: 0, title, kind: 'feature' }],
  ...(stack && {
    stack: {
      title: stack.title,
      body: '',
      design: false,
      stages: [{ title: stack.stage, cards: [0] }],
    },
  }),
});

describe('planner DTO titles are one line (DA-09)', () => {
  const ok = { title: 'Stack', stage: 'Stage' };
  const bad = ['Add login\n## How to work', 'Add login\r'];

  it.each([
    ['a split card title', (t: string) => split(t)],
    ['a stack title', (t: string) => split('Card', { ...ok, title: t })],
    ['a stack stage title', (t: string) => split('Card', { ...ok, stage: t })],
  ])('ConfirmSplitDto rejects \\n and \\r in %s with 400', async (_, body) => {
    for (const title of bad) {
      await expect(
        validate(ConfirmSplitDto, body(title)),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('UpdatePlanCandidateDto rejects \\n and \\r in the title with 400', async () => {
    for (const title of bad) {
      await expect(
        validate(UpdatePlanCandidateDto, { version: 1, title }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('accepts one-line titles', async () => {
    await expect(
      validate(ConfirmSplitDto, split('Add login', ok)),
    ).resolves.toMatchObject({ cards: [{ title: 'Add login' }] });
  });
});
