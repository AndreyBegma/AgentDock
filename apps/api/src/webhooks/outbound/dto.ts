import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX,
  type WebhookCreateRequest,
  type WebhookDeliveryStatus,
  type WebhookEventType,
  type WebhookSettingsView,
  type WebhookUpdateRequest,
} from '@agentdock/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CURSOR_PATTERN } from '../../activity';

const NAME_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 2048;
const PROJECT_IDS_MAX = 100;
const ID_MAX_LENGTH = 64;
const TARGET_MAX_LENGTH = 253;

/** `POST /admin/webhooks`. The URL's target is checked by the service (D15). */
export class WebhookCreateDto implements WebhookCreateRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(URL_MAX_LENGTH)
  url!: string;

  /** D9: a non-empty subset of the catalogue. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events!: WebhookEventType[];

  /** Empty: every project. */
  @IsArray()
  @ArrayMaxSize(PROJECT_IDS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(ID_MAX_LENGTH, { each: true })
  projectIds!: string[];
}

/** `PATCH /admin/webhooks/:id` — only the fields sent change. */
export class WebhookUpdateDto implements WebhookUpdateRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(URL_MAX_LENGTH)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  events?: WebhookEventType[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PROJECT_IDS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(ID_MAX_LENGTH, { each: true })
  projectIds?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `GET /admin/webhooks/:id/deliveries?status=&cursor=`. */
export class WebhookDeliveriesQuery {
  @IsOptional()
  @IsIn(WEBHOOK_DELIVERY_STATUSES)
  status?: WebhookDeliveryStatus;

  @IsOptional()
  @IsString()
  @Matches(CURSOR_PATTERN)
  cursor?: string;
}

/** `PUT /admin/settings/webhooks`. Entries are checked by `WebhookSettingsService`. */
export class WebhookSettingsDto implements WebhookSettingsView {
  @IsArray()
  @ArrayMaxSize(WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX)
  @IsString({ each: true })
  @MaxLength(TARGET_MAX_LENGTH, { each: true })
  allowedPrivateTargets!: string[];
}
