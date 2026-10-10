import { computeProjectHealth, type HealthApp } from './github-health';

const NOW = new Date('2026-10-10T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const app = (over: Partial<HealthApp> = {}): HealthApp => ({
  hookActive: true,
  lastDeliveryAt: ago(5),
  lastSignatureFailureAt: null,
  hookCheckedAt: null,
  hookCheckOk: null,
  ...over,
});
const installation = (over = {}) => ({
  suspended: false,
  syncedAt: ago(30),
  lastDeliveryAt: ago(5),
  ...over,
});

describe('project App health (spec 27 D10, D11)', () => {
  it('is healthy when covered with a verified delivery in the last hour', () => {
    expect(computeProjectHealth(app(), [installation()], NOW)).toEqual({
      covered: true,
      state: 'healthy',
      reason: null,
    });
  });

  it('names the first failing rule', () => {
    expect(computeProjectHealth(null, [installation()], NOW)).toEqual({
      covered: false,
      state: 'unhealthy',
      reason: 'not_registered',
    });
    expect(
      computeProjectHealth(app({ hookActive: false }), [installation()], NOW),
    ).toMatchObject({ covered: true, reason: 'hook_inactive' });
    expect(computeProjectHealth(app(), [], NOW)).toEqual({
      covered: false,
      state: 'unhealthy',
      reason: 'not_covered',
    });
    expect(
      computeProjectHealth(app(), [installation({ suspended: true })], NOW),
    ).toMatchObject({ covered: false, reason: 'installation_suspended' });
  });

  it('turns unhealthy after a signature failure until the next verified delivery', () => {
    const failed = app({
      lastDeliveryAt: ago(10),
      lastSignatureFailureAt: ago(2),
    });
    expect(computeProjectHealth(failed, [installation()], NOW).reason).toBe(
      'signature_failure',
    );
    const recovered = app({
      lastDeliveryAt: ago(1),
      lastSignatureFailureAt: ago(2),
    });
    expect(computeProjectHealth(recovered, [installation()], NOW).state).toBe(
      'healthy',
    );
  });

  it('needs a delivery for the installation, or a recent resync with a good check', () => {
    const stale = installation({ lastDeliveryAt: ago(61) });
    expect(computeProjectHealth(app(), [stale], NOW).reason).toBe(
      'no_recent_delivery',
    );
    const checked = app({ hookCheckedAt: ago(10), hookCheckOk: true });
    expect(
      computeProjectHealth(
        checked,
        [installation({ lastDeliveryAt: null })],
        NOW,
      ).state,
    ).toBe('healthy');
    const badCheck = app({ hookCheckedAt: ago(10), hookCheckOk: false });
    expect(
      computeProjectHealth(
        badCheck,
        [installation({ lastDeliveryAt: null })],
        NOW,
      ).reason,
    ).toBe('no_recent_delivery');
    const oldSync = installation({ lastDeliveryAt: null, syncedAt: ago(90) });
    expect(computeProjectHealth(checked, [oldSync], NOW).state).toBe(
      'unhealthy',
    );
  });
});
