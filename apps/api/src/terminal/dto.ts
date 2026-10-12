import type { TerminalTicketRequest } from '@agentdock/shared';
import {
  SLOT_NAME_MAX_LENGTH,
  type TerminalMode,
  type TerminalTargetKind,
  terminalModeSchema,
} from '@agentdock/shared/protocol';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const TARGET_KINDS: TerminalTargetKind[] = [
  'slot',
  'orchestrator',
  'skill_run',
];
const ID_MAX_LENGTH = 64;

/**
 * `POST /terminal/tickets` (spec 29 D5). A target is named by kind and ids
 * only — the runner resolves the session (D2); there is no field for a
 * session name or a command, and the global pipe refuses unknown fields.
 */
export class TerminalTicketDto implements TerminalTicketRequest {
  @IsIn(TARGET_KINDS)
  kind!: TerminalTargetKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  projectId!: string;

  /** Required for `slot` — the protocol's `slotNameSchema` rule. Another kind with it is 400. */
  @ValidateIf(
    (dto: TerminalTicketDto) => dto.kind === 'slot' || dto.slot !== undefined,
  )
  @IsString()
  @MaxLength(SLOT_NAME_MAX_LENGTH)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'slot must match ^[a-z0-9][a-z0-9-]*$',
  })
  slot?: string;

  /** Required for `skill_run` — `terminalRunIdSchema`'s rule. Another kind with it is 400. */
  @ValidateIf(
    (dto: TerminalTicketDto) =>
      dto.kind === 'skill_run' || dto.runId !== undefined,
  )
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'runId must match ^[A-Za-z0-9_-]{1,64}$',
  })
  runId?: string;

  @IsIn(terminalModeSchema.options)
  mode!: TerminalMode;
}

/** `GET /terminal/active?projectId=`. */
export class TerminalActiveQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  projectId!: string;
}
