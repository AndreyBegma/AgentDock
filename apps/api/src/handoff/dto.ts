import {
  HANDOFF_NOTE_MAX_CHARS,
  type PutCardHandoffBody,
} from '@nautelle/shared';
import { IsString, MaxLength } from 'class-validator';

/**
 * `PUT /board/cards/:number/handoff` (#449 D7): the whole edited note. The
 * bound is loose on purpose: a note over the D5 cap gets `too_large` among
 * the 422 reasons instead of a bare 400.
 */
export class PutCardHandoffDto implements PutCardHandoffBody {
  @IsString()
  @MaxLength(HANDOFF_NOTE_MAX_CHARS * 2)
  content!: string;
}
