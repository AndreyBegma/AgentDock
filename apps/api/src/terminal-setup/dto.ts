import {
  type IgnoreTerminalSetupProfileRequest,
  TERMINAL_SETUP_PROFILE_KEY_MAX_LENGTH,
} from '@nautelle/shared';
import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';

/** `PUT /projects/:projectId/terminal-setup/ignored-profiles` (#719). */
export class IgnoreTerminalSetupProfileDto
  implements IgnoreTerminalSetupProfileRequest
{
  @IsString()
  @MaxLength(TERMINAL_SETUP_PROFILE_KEY_MAX_LENGTH)
  @Matches(/^\S+$/, { message: 'profileKey must be one word' })
  profileKey!: string;

  @IsBoolean()
  ignored!: boolean;
}
