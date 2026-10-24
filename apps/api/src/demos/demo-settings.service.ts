import {
  DEMO_ERROR,
  DEMO_SECRET_NAME_MAX,
  DEMO_SECRET_NAME_PATTERN,
  DEMO_SECRETS_MAX,
  DEMO_UI_PATHS_DEFAULT,
  type DemoSecretView,
  type DemoSettingsView,
  type UpdateDemoSettingsRequest,
} from '@nautelle/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { SecretCipher, SecretCipherError } from '../common/crypto';
import { PrismaService } from '../database/prisma.service';
import {
  demoError,
  demoSecretNotFound,
  encryptionUnavailable,
} from './demos-error';

const UPDATED_BY = {
  updatedBy: { select: { name: true, email: true } },
} as const;

/** A secret name from the path; anything else is no secret. */
export const demoSecretName = (value: string): string => {
  if (
    value.length > DEMO_SECRET_NAME_MAX ||
    !DEMO_SECRET_NAME_PATTERN.test(value)
  ) {
    throw new BadRequestException(
      'A demo secret name is an environment variable name: ^[A-Z_][A-Z0-9_]*$, at most 64 characters',
    );
  }
  return value;
};

/**
 * A project's Demo videos settings and its Demo env secrets (C-368,
 * ADR-0090). Any member reads them; a project admin writes them. A secret's
 * value is sealed with `APP_ENCRYPTION_KEY` and never returned — every route
 * answers with names. Every write is audited, never with a value.
 */
@Injectable()
export class DemoSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: SecretCipher,
  ) {}

  async view(projectId: string): Promise<DemoSettingsView> {
    const row = await this.prisma.boardSettings.findUnique({
      where: { projectId },
      select: {
        demoVideosEnabled: true,
        demoUiPaths: true,
        demoTelegram: true,
      },
    });
    return {
      enabled: row?.demoVideosEnabled ?? false,
      uiPaths: row?.demoUiPaths ?? [...DEMO_UI_PATHS_DEFAULT],
      telegram: row?.demoTelegram ?? true,
    };
  }

  async update(
    projectId: string,
    input: UpdateDemoSettingsRequest,
    userId: string,
    ctx: AuditContext,
  ): Promise<DemoSettingsView> {
    const data = {
      ...(input.enabled !== undefined
        ? { demoVideosEnabled: input.enabled }
        : {}),
      ...(input.uiPaths !== undefined ? { demoUiPaths: input.uiPaths } : {}),
      ...(input.telegram !== undefined ? { demoTelegram: input.telegram } : {}),
    };
    const before = await this.view(projectId);
    if (Object.keys(data).length === 0) return before;
    await this.prisma.boardSettings.upsert({
      where: { projectId },
      create: { projectId, ...data, updatedById: userId },
      update: { ...data, updatedById: userId },
    });
    const after = await this.view(projectId);
    await this.audit.record({
      ...ctx,
      action: 'demo.settings_updated',
      target: { type: 'project', id: projectId },
      projectId,
      before,
      after,
      result: 'ok',
    });
    return after;
  }

  async secrets(projectId: string): Promise<DemoSecretView[]> {
    const rows = await this.prisma.projectDemoSecret.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      include: UPDATED_BY,
    });
    return rows.map((row) => ({
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedBy
        ? (row.updatedBy.name ?? row.updatedBy.email)
        : null,
    }));
  }

  /**
   * Sets or replaces one secret. 409 without an encryption key — a secret is
   * never stored in the clear; 422 when a new name would pass
   * `DEMO_SECRETS_MAX`, counted under the project's lock.
   */
  async putSecret(
    projectId: string,
    name: string,
    value: string,
    userId: string,
    ctx: AuditContext,
  ): Promise<DemoSecretView> {
    if (!this.cipher.available) throw encryptionUnavailable();
    const valueCiphertext = this.cipher.encrypt(value);
    const replaced = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`demo-secrets:${projectId}`}))`;
      const existing = await tx.projectDemoSecret.findUnique({
        where: { projectId_name: { projectId, name } },
        select: { id: true },
      });
      if (existing) {
        await tx.projectDemoSecret.update({
          where: { id: existing.id },
          data: { valueCiphertext, updatedById: userId },
        });
        return true;
      }
      const count = await tx.projectDemoSecret.count({ where: { projectId } });
      if (count >= DEMO_SECRETS_MAX) {
        throw demoError(
          422,
          DEMO_ERROR.tooManySecrets,
          `A project holds at most ${DEMO_SECRETS_MAX} demo secrets`,
        );
      }
      await tx.projectDemoSecret.create({
        data: { projectId, name, valueCiphertext, updatedById: userId },
      });
      return false;
    });
    await this.audit.record({
      ...ctx,
      action: 'demo.secret_set',
      target: { type: 'project', id: projectId },
      projectId,
      after: { name, replaced },
      result: 'ok',
    });
    const view = (await this.secrets(projectId)).find(
      (secret) => secret.name === name,
    );
    if (!view) throw demoSecretNotFound();
    return view;
  }

  async deleteSecret(
    projectId: string,
    name: string,
    ctx: AuditContext,
  ): Promise<void> {
    const { count } = await this.prisma.projectDemoSecret.deleteMany({
      where: { projectId, name },
    });
    if (count === 0) throw demoSecretNotFound();
    await this.audit.record({
      ...ctx,
      action: 'demo.secret_deleted',
      target: { type: 'project', id: projectId },
      projectId,
      before: { name },
      result: 'ok',
    });
  }

  /**
   * The runner's `GET …/demos/:demoId/env`: every secret of the project,
   * opened. 409 without the key that sealed them.
   */
  async openSecrets(projectId: string): Promise<Record<string, string>> {
    const rows = await this.prisma.projectDemoSecret.findMany({
      where: { projectId },
      select: { name: true, valueCiphertext: true },
      orderBy: { name: 'asc' },
    });
    if (rows.length > 0 && !this.cipher.available) {
      throw encryptionUnavailable();
    }
    const env: Record<string, string> = {};
    try {
      for (const row of rows) {
        env[row.name] = this.cipher.decrypt(row.valueCiphertext);
      }
    } catch (error) {
      // Sealed with another key, or altered: the message names neither.
      if (error instanceof SecretCipherError) throw encryptionUnavailable();
      throw error;
    }
    return env;
  }
}
