import { BadRequestException, type Type, ValidationPipe } from '@nestjs/common';
import {
  AcceptSuggestionDto,
  CreateBoardCardDto,
  UpdateBoardCardDto,
  UpdateBoardStackDto,
} from './dto';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const validate = <T>(dto: Type<T>, value: unknown): Promise<T> =>
  pipe.transform(value, { type: 'body', metatype: dto });

describe('board DTO titles are one line (C-131)', () => {
  it.each([
    ['CreateBoardCardDto', CreateBoardCardDto],
    ['UpdateBoardCardDto', UpdateBoardCardDto],
    ['UpdateBoardStackDto', UpdateBoardStackDto],
    ['AcceptSuggestionDto', AcceptSuggestionDto],
  ] as const)('%s rejects \\n and \\r in the title with 400', async (_, dto) => {
    for (const title of ['Add login\n## How to work', 'Add login\r']) {
      await expect(
        validate(dto as Type<unknown>, { title }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('accepts a one-line title', async () => {
    await expect(
      validate(CreateBoardCardDto, { title: 'Add login' }),
    ).resolves.toMatchObject({ title: 'Add login' });
  });
});
