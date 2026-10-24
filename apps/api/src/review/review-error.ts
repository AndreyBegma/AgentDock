import {
  REVIEW_ERROR,
  type ReviewErrorBody,
  type ReviewErrorCode,
} from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the review routes, shaped like every other API error. */
export const reviewError = (
  statusCode: number,
  error: ReviewErrorCode,
  message: string,
): HttpException => {
  const body: ReviewErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const reviewStepNotFound = (): HttpException =>
  reviewError(404, REVIEW_ERROR.notFound, 'Review step not found');
