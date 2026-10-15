import type { TextOwnerType } from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** One field whose English text was just written to its owner's column. */
export interface AppliedTextField {
  field: string;
  original: string;
  english: string;
}

/**
 * What an owner module tells the text module about its owner type (issue
 * #271 D10, "API"):
 * - `publish` — the owner's own live event, once a result lands;
 * - `derive` — the values that follow an applied field (a card's fingerprint,
 *   a plan's title), in the transaction that applied it;
 * - `settled` — once a request ended for good (applied, skipped, or failed
 *   past its retries), after the owner's live event: what waits on the
 *   English text (a card's assessment, #322 D6) starts there.
 *
 * The owner modules depend on `TextModule` to request normalization, so the
 * text module reaches back through this registry rather than importing them.
 */
export interface TextOwnerHooks {
  publish(projectId: string, ownerId: string): void | Promise<void>;
  derive?(
    tx: Prisma.TransactionClient,
    ownerId: string,
    applied: readonly AppliedTextField[],
  ): Promise<void>;
  settled?(projectId: string, ownerId: string): void | Promise<void>;
}

@Injectable()
export class TextOwners {
  private readonly logger = new Logger(TextOwners.name);
  private readonly hooks = new Map<TextOwnerType, TextOwnerHooks>();

  register(ownerType: TextOwnerType, hooks: TextOwnerHooks): void {
    this.hooks.set(ownerType, hooks);
  }

  async derive(
    tx: Prisma.TransactionClient,
    ownerType: TextOwnerType,
    ownerId: string,
    applied: readonly AppliedTextField[],
  ): Promise<void> {
    if (applied.length === 0) return;
    await this.hooks.get(ownerType)?.derive?.(tx, ownerId, applied);
  }

  /** Best effort: a live event never fails the result that caused it. */
  async publish(
    ownerType: TextOwnerType,
    projectId: string,
    ownerId: string,
  ): Promise<void> {
    try {
      await this.hooks.get(ownerType)?.publish(projectId, ownerId);
    } catch (error) {
      this.logger.warn(
        `${ownerType} ${ownerId}: live event not published: ${(error as Error).message}`,
      );
    }
  }

  /** Best effort: what follows a settled request never fails the request. */
  async settled(
    ownerType: TextOwnerType,
    projectId: string,
    ownerId: string,
  ): Promise<void> {
    try {
      await this.hooks.get(ownerType)?.settled?.(projectId, ownerId);
    } catch (error) {
      this.logger.warn(
        `${ownerType} ${ownerId}: settled hook failed: ${(error as Error).message}`,
      );
    }
  }
}
