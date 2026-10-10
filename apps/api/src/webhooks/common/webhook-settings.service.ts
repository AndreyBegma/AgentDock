import {
  normalizeAllowedTarget,
  WEBHOOKS_ALLOWED_PRIVATE_TARGETS_KEY,
  WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { AuditContext } from '../../audit/audit.types';
import { SettingsService } from '../../settings/settings.service';
import { isValidAllowlistEntry, TargetAllowlist } from './ssrf-guard';
import { webhooksError } from './webhooks-error';

/**
 * `webhooks.allowedPrivateTargets` (D15) in `settings`: the hosts and CIDRs an
 * outbound webhook may reach although they are private. Read before every
 * check, so a change applies to the next attempt.
 */
@Injectable()
export class WebhookSettingsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** The stored entries; anything malformed in the row is ignored. */
  async allowedPrivateTargets(): Promise<string[]> {
    const value = await this.settings.get(WEBHOOKS_ALLOWED_PRIVATE_TARGETS_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is string =>
        typeof entry === 'string' && isValidAllowlistEntry(entry),
    );
  }

  async allowlist(): Promise<TargetAllowlist> {
    return new TargetAllowlist(await this.allowedPrivateTargets());
  }

  /**
   * Replaces the list. Each entry is normalised (trimmed, lower-cased) and
   * de-duplicated; one that is neither a host name nor an IP/CIDR → 422
   * `invalid_target`. Audited as `settings.webhooks`.
   */
  async setAllowedPrivateTargets(
    entries: readonly string[],
    userId: string,
    ctx: AuditContext,
  ): Promise<string[]> {
    if (entries.length > WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX) {
      throw webhooksError(
        422,
        WEBHOOKS_ERROR.invalidTarget,
        `At most ${WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX} entries`,
      );
    }
    const next: string[] = [];
    for (const entry of entries) {
      const normalized = normalizeAllowedTarget(entry);
      if (normalized === null || !isValidAllowlistEntry(normalized)) {
        throw webhooksError(
          422,
          WEBHOOKS_ERROR.invalidTarget,
          `Not a host name, IP address or CIDR: ${entry.slice(0, 100)}`,
        );
      }
      if (!next.includes(normalized)) next.push(normalized);
    }

    const before = await this.allowedPrivateTargets();
    await this.settings.set(WEBHOOKS_ALLOWED_PRIVATE_TARGETS_KEY, next, userId);
    await this.audit.record({
      ...ctx,
      action: 'settings.webhooks',
      target: { type: 'setting', id: WEBHOOKS_ALLOWED_PRIVATE_TARGETS_KEY },
      before: { allowedPrivateTargets: before },
      after: { allowedPrivateTargets: next },
      result: 'ok',
    });
    return next;
  }
}
