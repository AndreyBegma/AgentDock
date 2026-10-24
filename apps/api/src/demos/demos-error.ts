import {
  DEMO_ERROR,
  type DemoErrorBody,
  type DemoErrorCode,
} from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the demo routes, shaped like every other API error. */
export const demoError = (
  statusCode: number,
  error: DemoErrorCode,
  message: string,
): HttpException => {
  const body: DemoErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const demoNotFound = (): HttpException =>
  demoError(404, DEMO_ERROR.notFound, 'Demo not found');

export const demoSecretNotFound = (): HttpException =>
  demoError(404, DEMO_ERROR.notFound, 'Demo secret not found');

export const demoNotActive = (): HttpException =>
  demoError(
    409,
    DEMO_ERROR.notActive,
    'The demo is no longer queued or recording',
  );

export const encryptionUnavailable = (): HttpException =>
  demoError(
    409,
    DEMO_ERROR.encryptionUnavailable,
    'APP_ENCRYPTION_KEY is not configured or does not open the stored demo secrets',
  );
