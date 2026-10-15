import { existsSync } from 'node:fs';
import {
  CARD_INSTRUCTIONS_PATH,
  readCardInstructions,
  runnerTakesPlanAttachments,
} from './plan-intake';

describe('runnerTakesPlanAttachments (#337 D10)', () => {
  it('is true from 0.9.2 on', () => {
    for (const version of ['0.9.2', '0.9.10', '0.10.0', '1.0.0', 'v0.9.2']) {
      expect(runnerTakesPlanAttachments(version)).toBe(true);
    }
  });

  it('is false for an older, unknown or unreadable version', () => {
    for (const version of ['0.9.1', '0.8.9', '', 'dev', null]) {
      expect(runnerTakesPlanAttachments(version)).toBe(false);
    }
  });
});

describe('the card-mode instructions', () => {
  it('are read from the shared package and carry the intake rules', () => {
    expect(existsSync(CARD_INSTRUCTIONS_PATH)).toBe(true);
    const body = readCardInstructions();
    for (const rule of [
      'At most **4 rounds**',
      'language of the person',
      '**English**',
      '## What to do',
      '## Acceptance criteria',
      '## Out of scope',
      '## Open questions',
    ]) {
      expect(body).toContain(rule);
    }
  });
});
