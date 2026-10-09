import { describe, expect, it } from 'bun:test';
import {
  defaultChannels,
  kindAllowsChannel,
  kindsFor,
  NOTIFICATION_KIND_SPECS,
  NOTIFICATION_KINDS,
} from './kinds';

describe('notification kinds (spec 22 D1)', () => {
  it('describes every kind', () => {
    expect(Object.keys(NOTIFICATION_KIND_SPECS).sort()).toEqual(
      [...NOTIFICATION_KINDS].sort(),
    );
  });

  it('keeps queue.dry off Telegram by default', () => {
    expect(defaultChannels('queue.dry', 'operator')).toEqual({
      inApp: true,
      telegram: false,
    });
  });

  it('keeps pr.awaiting_approval off Telegram for viewers only', () => {
    expect(defaultChannels('pr.awaiting_approval', 'viewer').telegram).toBe(
      false,
    );
    expect(defaultChannels('pr.awaiting_approval', 'operator').telegram).toBe(
      true,
    );
    expect(defaultChannels('pr.awaiting_approval', 'admin').telegram).toBe(
      true,
    );
  });

  it('never sends runner.online to Telegram', () => {
    expect(kindAllowsChannel('runner.online', 'telegram')).toBe(false);
    expect(defaultChannels('runner.online', 'admin').telegram).toBe(false);
  });

  it('offers runner kinds to admins only and hides reserved kinds', () => {
    expect(kindsFor('operator')).not.toContain('runner.offline');
    expect(kindsFor('admin')).toContain('runner.offline');
    expect(kindsFor('admin')).not.toContain('budget.exceeded');
  });

  it('returns a copy of the defaults', () => {
    defaultChannels('pane.prompt', 'admin').telegram = false;
    expect(defaultChannels('pane.prompt', 'admin').telegram).toBe(true);
  });
});
