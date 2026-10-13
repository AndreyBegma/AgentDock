import { describe, expect, test } from 'bun:test';
import { liveDotLabel, liveStatusLabel } from './live-status';

describe('liveDotLabel', () => {
  test('names live updates in every state', () => {
    expect(liveDotLabel('connected', false)).toBe('Live updates connected');
    expect(liveDotLabel('reconnecting', false)).toBe(
      'Live updates reconnecting',
    );
    expect(liveDotLabel('reconnecting', true)).toBe('Live updates paused');
    expect(liveDotLabel('offline', false)).toBe('Live updates paused');
  });
});

describe('liveStatusLabel', () => {
  test('connected is Live, whatever the timer says', () => {
    expect(liveStatusLabel('connected', false)).toBe('Live');
    expect(liveStatusLabel('connected', true)).toBe('Live');
  });

  test('a short drop is Reconnecting…', () => {
    expect(liveStatusLabel('reconnecting', false)).toBe('Reconnecting…');
  });

  test('a client that gave up is paused at once: it is not reconnecting', () => {
    expect(liveStatusLabel('offline', false)).toBe('Live updates paused');
  });

  test('a long drop is paused, never "Offline"', () => {
    expect(liveStatusLabel('reconnecting', true)).toBe('Live updates paused');
    expect(liveStatusLabel('offline', true)).toBe('Live updates paused');
  });
});
