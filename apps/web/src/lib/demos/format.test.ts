import { describe, expect, test } from 'bun:test';
import type { CardDemoView } from '@nautelle/shared';
import { demoVideoIds, withoutDemoVideos } from './format';

const demo = (attachmentId: string | null) =>
  ({ attachmentId }) as unknown as CardDemoView;

describe('demo videos in the Attachments list', () => {
  test('collects the attachment ids of the demos that have a video', () => {
    expect(demoVideoIds([demo('a1'), demo(null), demo('a2')])).toEqual([
      'a1',
      'a2',
    ]);
  });

  test('leaves the videos out and keeps other attachments', () => {
    const files = [{ id: 'a1' }, { id: 'shot' }, { id: 'a2' }];
    expect(withoutDemoVideos(files, ['a1', 'a2'])).toEqual([{ id: 'shot' }]);
  });
});
