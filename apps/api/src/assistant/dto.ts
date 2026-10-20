import {
  type AddAssistantAttachmentRequest,
  ASSISTANT_MESSAGE_MAX,
  ASSISTANT_TITLE_MAX,
  type AssistantStreamRequest,
  type CreateAssistantConversationRequest,
  LLM_PROVIDERS,
  type LlmProviderId,
  type UpdateAssistantConversationRequest,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MODEL_ID } from '../llm/dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A cuid or any id of ours: no separators, no spaces. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ConversationParam {
  @Matches(ID)
  id!: string;
}

export class AttachmentParam extends ConversationParam {
  @Matches(ID)
  attachmentId!: string;
}

export class CreateAssistantConversationDto
  implements CreateAssistantConversationRequest
{
  @IsOptional()
  @Matches(ID)
  projectId?: string | null;

  /** With `model`; both or neither. */
  @ValidateIf((o: CreateAssistantConversationDto) => o.model != null)
  @IsIn(LLM_PROVIDERS)
  provider?: LlmProviderId | null;

  @ValidateIf((o: CreateAssistantConversationDto) => o.provider != null)
  @IsString()
  @MaxLength(200)
  @Matches(MODEL_ID, { message: 'model must be a model id' })
  model?: string | null;
}

export class UpdateAssistantConversationDto
  extends CreateAssistantConversationDto
  implements UpdateAssistantConversationRequest
{
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(ASSISTANT_TITLE_MAX)
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
  title?: string;
}

export class AddAssistantAttachmentDto {
  @IsIn(['card', 'session'])
  kind!: AddAssistantAttachmentRequest['kind'];

  @ValidateIf((o: AddAssistantAttachmentDto) => o.kind === 'card')
  @Matches(ID)
  projectId?: string;

  @ValidateIf((o: AddAssistantAttachmentDto) => o.kind === 'card')
  @IsInt()
  @Min(1)
  @Max(999_999_999)
  cardNumber?: number;

  @ValidateIf((o: AddAssistantAttachmentDto) => o.kind === 'session')
  @Matches(ID)
  sessionId?: string;
}

export class AssistantStreamDto implements AssistantStreamRequest {
  @IsString()
  @Matches(/\S/, { message: 'message must not be blank' })
  @MaxLength(ASSISTANT_MESSAGE_MAX)
  message!: string;
}
