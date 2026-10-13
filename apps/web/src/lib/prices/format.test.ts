import { expect, test } from 'bun:test';
import { PRICE_SOURCES } from '@agentdock/shared';
import { BUCKET_LABEL, SOURCE_LABEL, TEST_BUCKETS } from './format';

test('every bucket and source reads as words, not a field name or enum (R5)', () => {
  for (const bucket of TEST_BUCKETS) {
    expect(BUCKET_LABEL[bucket]).not.toMatch(/[a-z][A-Z]/);
  }
  for (const source of PRICE_SOURCES) {
    expect(SOURCE_LABEL[source]).not.toBe(source);
  }
});
