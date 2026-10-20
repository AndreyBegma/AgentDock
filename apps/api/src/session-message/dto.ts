import {
  SESSION_MESSAGE_MAX_CHARS,
  type SessionMessageInput,
} from '@nautelle/shared';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * `POST /board/cards/:number/message` and
 * `POST /projects/:id/slots/:slot/session-message` (#489). The text is
 * cleaned by the service, so it may still hold what cleaning removes.
 */
export class SessionMessageDto {
  @IsIn(['text', 'option', 'other'])
  kind!: SessionMessageInput['kind'];

  @ValidateIf((o: SessionMessageDto) => o.kind !== 'option')
  @IsString()
  @Matches(/\S/, { message: 'text must not be blank' })
  @MaxLength(SESSION_MESSAGE_MAX_CHARS * 2)
  text?: string;

  @ValidateIf((o: SessionMessageDto) => o.kind !== 'text')
  @IsString()
  @Matches(/^[0-9a-f]{16}$/)
  questionKey?: string;

  @ValidateIf((o: SessionMessageDto) => o.kind === 'option')
  @IsInt()
  @Min(1)
  @Max(99)
  index?: number;
}

/** The DTO as the shared input; class-validator has checked each field. */
export const sessionMessageInput = (
  dto: SessionMessageDto,
): SessionMessageInput => {
  switch (dto.kind) {
    case 'text':
      return { kind: 'text', text: dto.text ?? '' };
    case 'option':
      return {
        kind: 'option',
        questionKey: dto.questionKey ?? '',
        index: dto.index ?? 0,
      };
    case 'other':
      return {
        kind: 'other',
        questionKey: dto.questionKey ?? '',
        text: dto.text ?? '',
      };
  }
};
