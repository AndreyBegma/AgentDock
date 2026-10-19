import {
  BOARD_ASK_QUESTION_MAX,
  type BoardAskRequest,
  TRIAGE_HINTS,
  type TriageHint,
  type TriageHintRequest,
} from '@agentdock/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `POST /board/ask`. */
export class BoardAskDto implements BoardAskRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(BOARD_ASK_QUESTION_MAX)
  question!: string;
}

/** `POST …/triage/dismiss` and `…/triage/apply`. */
export class TriageHintDto implements TriageHintRequest {
  @IsIn(TRIAGE_HINTS)
  hint!: TriageHint;
}
