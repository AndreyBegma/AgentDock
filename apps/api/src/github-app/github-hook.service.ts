import type { GitHubHookAnswer } from '@nautelle/shared';
import type { PollableCollector } from '@nautelle/shared/protocol';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { nextServerEventSeq } from '../server-events';
import { parseRawJson } from '../webhooks/common';
import { CollectorPollSender } from './collector-poll-sender';
import {
  GITHUB_APP_OPTIONS,
  type GitHubAppOptions,
} from './github-app-options';
import { GITHUB_APP_ROW_ID, GitHubAppStore } from './github-app-store';
import { GitHubHealthService } from './github-health.service';
import { GitHubInstallationsService } from './github-installations.service';
import {
  type GitHubPayloadFacts,
  type GitHubRouting,
  githubEventData,
  githubEventType,
  payloadFacts,
  routeGitHubEvent,
} from './github-routing';
import { verifyGitHubSignature } from './github-signature';
import { type DebouncedPoll, PollDebouncer } from './poll-debouncer';
import { SignatureFailureTracker } from './signature-failure-tracker';

/** `X-GitHub-Delivery` is a GUID; anything visible up to 100 characters is kept. */
const DELIVERY_ID = /^[\x21-\x7e]{1,100}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

export interface GitHubHookRequest {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  deliveryId: string | undefined;
  event: string | undefined;
}

/** What to do once the 200 is sent (D6: nothing slow happens before it). */
export interface GitHubHookWork {
  polls: { projectId: string; collectors: PollableCollector[] }[];
  resync: boolean;
}

export interface GitHubHookReceived {
  answer: GitHubHookAnswer;
  work: GitHubHookWork;
}

const NO_WORK: GitHubHookWork = { polls: [], resync: false };

interface MatchedProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
  baseBranch: string;
  baseOverride: string | null;
  githubRepoId: bigint | null;
}

/** D7: what a delivery changes on a matched project — its id, its new name. */
interface ProjectKeying {
  projectId: string;
  githubRepoId?: bigint;
  /** The repository was renamed (or transferred) on GitHub. */
  rename?: { from: string; to: string };
}

/**
 * `POST /hooks/github` (docs/specs/27-github-app.md D5–D9). Verifies
 * `X-Hub-Signature-256` over the raw bytes, dedupes by `X-GitHub-Delivery`,
 * maps the repository to projects (D7), records one `github.<event>` row per
 * project it polls (D9, spec notes) — all before answering. The polls,
 * debounced per project, and any resync run after the response (`after`).
 */
@Injectable()
export class GitHubHookService implements OnApplicationShutdown {
  private readonly logger = new Logger(GitHubHookService.name);
  readonly debouncer: PollDebouncer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: GitHubAppStore,
    private readonly installations: GitHubInstallationsService,
    private readonly health: GitHubHealthService,
    private readonly failures: SignatureFailureTracker,
    private readonly sender: CollectorPollSender,
    private readonly audit: AuditService,
    @Inject(GITHUB_APP_OPTIONS) options: GitHubAppOptions,
  ) {
    this.debouncer = new PollDebouncer({
      windowMs: options.debounceMs,
      flush: (poll) => this.sendPoll(poll),
    });
  }

  onApplicationShutdown(): void {
    this.debouncer.clear();
  }

  async receive(input: GitHubHookRequest): Promise<GitHubHookReceived> {
    const app = await this.store.load();
    // No App: nothing can verify the delivery.
    if (!app) throw new UnauthorizedException();
    const secret = this.store.webhookSecret(app);
    const rawBody = input.rawBody ?? Buffer.alloc(0);
    if (!secret || !verifyGitHubSignature(input.signature, rawBody, secret)) {
      // D6: 401 with no detail; only a counter and its time are kept. C-116:
      // counted in memory, the row written at most once a minute.
      const now = new Date();
      this.failures.record(now);
      const flush = this.failures.takeUnflushed(now);
      if (flush) {
        await this.prisma.gitHubApp.update({
          where: { id: GITHUB_APP_ROW_ID },
          data: {
            signatureFailures: { increment: flush.count },
            lastSignatureFailureAt: flush.at,
          },
        });
      }
      const logged = this.failures.takeUnlogged(now);
      if (logged > 0)
        this.logger.warn(
          `${logged} deliveries refused for signature in the last minute`,
        );
      this.health.recomputeSoon();
      throw new UnauthorizedException();
    }

    const { deliveryId, event } = input;
    if (!deliveryId || !DELIVERY_ID.test(deliveryId))
      throw new BadRequestException(
        'X-GitHub-Delivery is missing or malformed',
      );
    if (!event || !EVENT_NAME.test(event))
      throw new BadRequestException('X-GitHub-Event is missing or malformed');
    const body = parseRawJson(input.rawBody);
    if (!body.ok) throw new BadRequestException('The body is not JSON');

    const facts = payloadFacts(event, body.value);
    const routing = routeGitHubEvent(event, facts);
    const matched =
      routing.kind === 'poll' || routing.kind === 'rename'
        ? await this.projectsFor(
            facts,
            routing.kind === 'rename' ? routing.previousFullName : null,
          )
        : [];
    const keyings = keyingsFor(facts, matched);
    // Events rows carry the name the project has after this delivery.
    for (const keying of keyings)
      if (keying.rename) {
        const project = matched.find((p) => p.id === keying.projectId);
        if (project) project.repo = keying.rename.to;
      }
    const renames = keyings.flatMap((k) =>
      k.rename ? [{ projectId: k.projectId, ...k.rename }] : [],
    );
    const polls = routing.kind === 'poll' ? pollsFor(routing, matched) : [];
    const now = new Date();
    this.failures.clear();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.gitHubDelivery.create({
          data: {
            deliveryId,
            event,
            action: facts.action,
            fullName: facts.fullName,
            installationId: facts.installationId,
            receivedAt: now,
            handled:
              routing.kind === 'rename'
                ? matched.length > 0
                : routing.kind !== 'ignore' &&
                  (routing.kind !== 'poll' || polls.length > 0),
            projectsMatched: matched.length,
          },
        });
        await tx.gitHubApp.update({
          where: { id: GITHUB_APP_ROW_ID },
          data: { lastDeliveryAt: now },
        });
        for (const keying of keyings)
          await tx.project.update({
            where: { id: keying.projectId },
            data: {
              ...(keying.githubRepoId !== undefined
                ? { githubRepoId: keying.githubRepoId }
                : {}),
              ...(keying.rename ? { repo: keying.rename.to } : {}),
            },
          });
        for (const poll of polls) {
          const project = poll.project;
          // D9 (spec notes), ADR-0014: a negative seq; the ack cursor never sees it.
          const seq = await nextServerEventSeq(tx);
          await tx.event.create({
            data: {
              runnerId: project.runnerId,
              seq,
              ts: now,
              type: githubEventType(event),
              source: 'github',
              projectRepo: project.repo,
              projectRoot: project.rootPath,
              data: githubEventData(facts),
            },
          });
        }
      });
    } catch (error) {
      // D6: GitHub redelivers on its own; a stored id is 200, never 409.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return { answer: { status: 'duplicate' }, work: NO_WORK };
      throw error;
    }
    this.health.recomputeSoon();
    for (const rename of renames) {
      this.logger.log(
        `project ${rename.projectId}: repository renamed on GitHub, ${rename.from} → ${rename.to}`,
      );
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'project.repo_rename',
        target: { type: 'project', id: rename.projectId },
        projectId: rename.projectId,
        before: { repo: rename.from },
        after: { repo: rename.to },
        meta: { via: 'github', event, deliveryId, repoId: facts.repoId },
        result: 'ok',
      });
    }

    return {
      answer: {
        status: routing.kind === 'ignore' ? 'ignored' : 'accepted',
      },
      work: {
        polls: polls.map((p) => ({
          projectId: p.project.id,
          collectors: p.collectors,
        })),
        // A rename also renames the installation's repository: coverage (D10)
        // reads it by name.
        resync:
          routing.kind === 'resync' ||
          routing.kind === 'rename' ||
          renames.length > 0,
      },
    };
  }

  /** After the response: hands polls to the debouncer, starts a resync. */
  after(work: GitHubHookWork): void {
    for (const poll of work.polls)
      this.debouncer.request(poll.projectId, poll.collectors);
    if (work.resync) this.installations.resyncInBackground();
  }

  /**
   * D7: projects on this repository — by GitHub's repository id where a
   * project has one, else by name, case-insensitively. A project keyed to
   * another id is never matched by name: its repository was renamed away and
   * this is a different one under the old name. `previousFullName` (a
   * `renamed` delivery) also finds projects not yet keyed under the old name.
   */
  private projectsFor(
    facts: GitHubPayloadFacts,
    previousFullName: string | null,
  ): Promise<MatchedProject[]> {
    const repoId = facts.repoId === null ? null : BigInt(facts.repoId);
    const byName = (name: string): Prisma.ProjectWhereInput => ({
      repo: { equals: name, mode: 'insensitive' },
      ...(repoId === null ? {} : { githubRepoId: null }),
    });
    const where: Prisma.ProjectWhereInput[] = [];
    if (repoId !== null) where.push({ githubRepoId: repoId });
    if (facts.fullName) where.push(byName(facts.fullName));
    if (previousFullName) where.push(byName(previousFullName));
    if (where.length === 0) return Promise.resolve([]);
    return this.prisma.project.findMany({
      where: { OR: where },
      select: {
        id: true,
        runnerId: true,
        rootPath: true,
        repo: true,
        baseBranch: true,
        baseOverride: true,
        githubRepoId: true,
      },
    });
  }

  private async sendPoll(poll: DebouncedPoll): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: poll.projectId },
      select: { runnerId: true },
    });
    if (!project) return;
    const outcome = await this.sender
      .send(project.runnerId, {
        projectId: poll.projectId,
        collectors: poll.collectors,
      })
      .catch(() => 'failed' as const);
    // An offline runner just misses it: its own 60 s poll catches up (D6, D12).
    if (outcome === 'failed')
      this.logger.debug(`collector.poll for ${poll.projectId}: not delivered`);
  }
}

/**
 * D7: a project matched by name learns the repository's id; one whose stored
 * name is not the delivery's (a rename or transfer on GitHub) takes the new
 * name, as GitHub spells it.
 */
const keyingsFor = (
  facts: GitHubPayloadFacts,
  matched: MatchedProject[],
): ProjectKeying[] => {
  const repoId = facts.repoId === null ? null : BigInt(facts.repoId);
  const keyings: ProjectKeying[] = [];
  for (const project of matched) {
    const keying: ProjectKeying = { projectId: project.id };
    if (repoId !== null && project.githubRepoId === null)
      keying.githubRepoId = repoId;
    if (
      facts.repoName !== null &&
      project.repo.toLowerCase() !== facts.repoName.toLowerCase()
    )
      keying.rename = { from: project.repo, to: facts.repoName };
    if (keying.githubRepoId !== undefined || keying.rename)
      keyings.push(keying);
  }
  return keyings;
};

/** D8: the polls a routing asks of each matched project; a push only on its base branch. */
const pollsFor = (
  routing: Extract<GitHubRouting, { kind: 'poll' }>,
  matched: MatchedProject[],
): { project: MatchedProject; collectors: PollableCollector[] }[] =>
  matched
    .filter(
      (project) =>
        routing.branch === null ||
        routing.branch === (project.baseOverride ?? project.baseBranch),
    )
    .map((project) => ({ project, collectors: routing.collectors }));
