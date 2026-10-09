import type {
  NotificationErrorBody,
  NotificationErrorCode,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the notification routes, shaped like every other API error. */
export const notificationError = (
  statusCode: number,
  error: NotificationErrorCode,
  message: string,
): HttpException => {
  const body: NotificationErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

/** Another user's notification, or none: the same answer (spec 22 "Authorization"). */
export const notificationNotFound = (): HttpException =>
  notificationError(404, 'notification_not_found', 'Notification not found');

/** A project the caller cannot see, or none. */
export const mutedProjectNotFound = (): HttpException =>
  notificationError(404, 'project_not_found', 'Project not found');

/** D8: secrets are never stored without `APP_ENCRYPTION_KEY`. */
export const encryptionKeyMissing = (): HttpException =>
  notificationError(
    409,
    'encryption_key_missing',
    'APP_ENCRYPTION_KEY is not configured (32 random bytes, base64); the Telegram integration cannot store its token without it',
  );
