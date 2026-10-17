import type {
  TelegramBotTokenUpdate,
  TelegramSignInRequest,
} from '@agentdock/shared';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * `PUT /admin/integrations/telegram`. The shape of a BotFather token —
 * `<bot id>:<secret>` — checked before anything is sent anywhere; whether it
 * works is `getMe`'s answer. The validation message never quotes the value.
 */
export class TelegramBotTokenDto implements TelegramBotTokenUpdate {
  @IsString()
  @MaxLength(128)
  @Matches(/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/, {
    message: 'token must be a Telegram bot token (<bot id>:<secret>)',
  })
  token!: string;
}

/** `POST /auth/telegram` (#580): the Mini App's `initData`, checked by its HMAC. */
export class TelegramSignInDto implements TelegramSignInRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  initData!: string;
}
