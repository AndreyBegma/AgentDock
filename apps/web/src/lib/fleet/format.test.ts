import { describe, expect, test } from 'bun:test';
import { SLOT_STATUSES } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  boardErrorHint,
  boardErrorView,
  CHANNEL_EXPLANATION,
  channelChip,
  describeFleetError,
  describeFleetErrorHint,
  formatAge,
  formatAgo,
  formatAheadBehind,
  formatOccupancy,
  formatRound,
  isNotFound,
  issueUrl,
  ORCHESTRATOR_STATUS_HINT,
  ORCHESTRATOR_STATUS_LABEL,
  parseIssueFilter,
  safeHttpsUrl,
  showStopControl,
  slotStatusOptions,
  slotsQuery,
} from './format';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('formatAge', () => {
  test('picks the coarsest honest unit', () => {
    expect(formatAge(ago(2), NOW)).toBe('just now');
    expect(formatAge(ago(30), NOW)).toBe('30 s');
    expect(formatAge(ago(5 * 60), NOW)).toBe('5 min');
    expect(formatAge(ago(3 * 3600), NOW)).toBe('3 h');
    expect(formatAge(ago(4 * 86400), NOW)).toBe('4 d');
  });

  test('a clock skewed into the future reads as just now', () => {
    expect(formatAge(ago(-600), NOW)).toBe('just now');
  });

  test('formatAgo never says "just now ago"', () => {
    expect(formatAgo(ago(2), NOW)).toBe('just now');
    expect(formatAgo(ago(5 * 60), NOW)).toBe('5 min ago');
  });
});

describe('formatAheadBehind / formatOccupancy / formatRound', () => {
  test('ahead and behind', () => {
    expect(formatAheadBehind(null, null)).toBe('—');
    expect(formatAheadBehind(2, 1)).toBe('↑2 ↓1');
    expect(formatAheadBehind(3, null)).toBe('↑3 ↓0');
  });

  test('occupancy', () => {
    expect(formatOccupancy(null)).toBe('—');
    expect(formatOccupancy({ occupied: 2, max: 4 })).toBe('2 / 4');
  });

  test('round label', () => {
    expect(formatRound('2026-10-08/1430')).toBe('2026-10-08 14:30');
    expect(formatRound('weird')).toBe('weird');
  });
});

describe('issueUrl / safeHttpsUrl', () => {
  test('derives the issue from a pull request of the same repository', () => {
    expect(issueUrl(11, 'https://github.com/o/r/pull/7')).toBe(
      'https://github.com/o/r/issues/11',
    );
  });

  test('no link without an issue or a pull request', () => {
    expect(issueUrl(null, 'https://github.com/o/r/pull/7')).toBeNull();
    expect(issueUrl(11, null)).toBeNull();
    expect(issueUrl(11, 'https://example.com/not-a-pr')).toBeNull();
  });

  test('only https links are rendered as anchors', () => {
    expect(safeHttpsUrl('https://github.com/o/r/pull/7')).toBe(
      'https://github.com/o/r/pull/7',
    );
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});

describe('slotsQuery / parseIssueFilter', () => {
  test('builds only the set parameters', () => {
    expect(slotsQuery({})).toBe('');
    expect(slotsQuery({ status: 'ended', issue: 42, cursor: 'c1' })).toBe(
      '?status=ended&issue=42&cursor=c1',
    );
  });

  test('the issue filter takes a positive whole number, with or without #', () => {
    expect(parseIssueFilter('42')).toBe(42);
    expect(parseIssueFilter(' #42 ')).toBe(42);
    expect(parseIssueFilter('')).toBeUndefined();
    expect(parseIssueFilter('0')).toBeUndefined();
    expect(parseIssueFilter('4x')).toBeUndefined();
    expect(parseIssueFilter('-3')).toBeUndefined();
  });
});

describe('errors', () => {
  test('a 404 is "not a member" or "gone"', () => {
    const err = new ApiError(404, undefined, 'Not Found');
    expect(isNotFound(err)).toBe(true);
    expect(describeFleetError(err)).toContain('not a member');
    expect(isNotFound(new Error('x'))).toBe(false);
  });
});

describe('describeFleetErrorHint', () => {
  test('a missing project links to Projects', () => {
    const hint = describeFleetErrorHint(new ApiError(404, undefined, 'x'));
    expect(hint.href).toBe('/projects');
    expect(hint.cta).toBe('Open Projects');
  });

  test('the string helper is the hint’s text', () => {
    const error = new ApiError(400, undefined, 'bad');
    expect(describeFleetError(error)).toBe(describeFleetErrorHint(error).text);
  });
});

describe('labels', () => {
  test('every orchestrator status has a label and a hint', () => {
    for (const status of ['running', 'idle', 'absent', 'unknown'] as const) {
      expect(ORCHESTRATOR_STATUS_LABEL[status]).not.toBe(status);
      expect(ORCHESTRATOR_STATUS_HINT[status].length).toBeGreaterThan(10);
    }
  });

  test('the status filter offers every slot status by its label', () => {
    const options = slotStatusOptions();
    expect(options.length).toBe(SLOT_STATUSES.length);
    expect(options.find((o) => o.value === 'prompt')?.label).toBe(
      'waiting on a prompt',
    );
  });

  test('a board error says where and what to do', () => {
    const text = boardErrorHint({
      reason: 'bad table',
      file: 'BOARD.md',
      line: 4,
    });
    expect(text).toContain('BOARD.md:4');
    expect(text).toContain('Fix that file');
  });

  test('a board error splits into a title, a detail and the path to copy', () => {
    const view = boardErrorView({
      reason: 'bad table',
      file: 'BOARD.md',
      line: 4,
    });
    expect(view.path).toBe('BOARD.md:4');
    expect(view.detail).toContain('bad table');
    expect(boardErrorView({ reason: 'x', file: 'A.md' }).path).toBe('A.md');
  });

  test('Stop is drawn unless the orchestrator is known to be absent', () => {
    expect(showStopControl('running')).toBe(true);
    expect(showStopControl('idle')).toBe(true);
    expect(showStopControl('unknown')).toBe(true);
    expect(showStopControl('absent')).toBe(false);
  });

  test('scraped is explained, events needs no explanation', () => {
    expect(CHANNEL_EXPLANATION.events).toBeNull();
    expect(CHANNEL_EXPLANATION.scraped).toContain('markdown');
    expect(CHANNEL_EXPLANATION.both).toContain('plugin events');
  });

  test('the channel badge names a mixed channel', () => {
    expect(channelChip('both').label).toBe('events + scraped');
  });
});

describe('channelChip', () => {
  test('events is ok', () => {
    const chip = channelChip('events');
    expect(chip.label).toBe('events');
    expect(chip.tone).toBe('ok');
    expect(chip.tooltip).toContain('events.jsonl');
  });

  test('scraped is neutral', () => {
    const chip = channelChip('scraped');
    expect(chip.label).toBe('scraped');
    expect(chip.tone).toBe('neutral');
    expect(chip.tooltip).toContain('markdown');
  });

  test('both is warn', () => {
    const chip = channelChip('both');
    expect(chip.label).toBe('events + scraped');
    expect(chip.tone).toBe('warn');
    expect(chip.tooltip).toContain('scraping');
  });
});

describe('describeFleetError (slot)', () => {
  test('a missing slot has its own sentence', () => {
    const err = new ApiError(404, 'slot_not_found' as never, 'Slot not found');
    expect(describeFleetError(err)).toBe('That slot no longer exists.');
  });
});
