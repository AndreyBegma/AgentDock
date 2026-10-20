import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

/** The largest Postgres `integer` (int4). */
export const INT4_MAX = 2 ** 31 - 1;
/** The largest Postgres `bigint` (int8). */
export const INT8_MAX = 2n ** 63n - 1n;

const POSITIVE_DECIMAL = /^[1-9]\d*$/;

/** `raw` as an int in 1..2^31-1, or null when it is not one. */
export const parsePositiveInt = (raw: string): number | null => {
  if (!POSITIVE_DECIMAL.test(raw) || raw.length > 10) return null;
  const value = Number(raw);
  return value <= INT4_MAX ? value : null;
};

/** `raw` as a BigInt in 1..2^63-1, or null when it is not one. */
export const parsePositiveBigInt = (raw: string): bigint | null => {
  if (!POSITIVE_DECIMAL.test(raw) || raw.length > 19) return null;
  const value = BigInt(raw);
  return value <= INT8_MAX ? value : null;
};

const outOfRange = (metadata: ArgumentMetadata, max: string) =>
  new BadRequestException(
    `${metadata.data ?? 'parameter'} must be an integer from 1 to ${max}`,
  );

/**
 * A route parameter that names an int4 column: 1..2^31-1, else 400. Plain
 * `ParseIntPipe` lets an out-of-range value through to the database, which
 * answers 500.
 */
@Injectable()
export class PositiveIntPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = parsePositiveInt(value);
    if (parsed === null) throw outOfRange(metadata, String(INT4_MAX));
    return parsed;
  }
}

/** A route parameter that names an int8 column: 1..2^63-1, else 400. */
@Injectable()
export class PositiveBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string, metadata: ArgumentMetadata): bigint {
    const parsed = parsePositiveBigInt(value);
    if (parsed === null) throw outOfRange(metadata, INT8_MAX.toString());
    return parsed;
  }
}
