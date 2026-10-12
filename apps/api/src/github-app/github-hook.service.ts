import type { GitHubHookAnswer } from '@agentdock/shared';
import type { PollableCollector } from '@agentdock/shared/protocol';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
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
  type GitHubRouting,
  githubEventData,
  githubEventType,
  payloadFacts,
  routeGitHubEvent,
} from './github-routing';
import { verifyGitHubSignature } from './github-signature';
import { type DebouncedPoll, PollDebouncer } from './poll-debouncer';

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
    private readonly sender: CollectorPollSender,
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
      // D6: 401 with no detail; only a counter and its time are kept.
      await this.prisma.gitHubApp.update({
        where: { id: GITHUB_APP_ROW_ID },
        data: {
          signatureFailures: { increment: 1 },
          lastSignatureFailureAt: new Date(),
        },
      });
      this.logger.warn(
        `delivery ${safeId(input.deliveryId)}: signature refused`,
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
      routing.kind === 'poll' ? await this.projectsFor(routing.fullName) : [];
    const polls = routing.kind === 'poll' ? pollsFor(routing, matched) : [];
    const now = new Date();

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
              routing.kind !== 'ignore' &&
              (routing.kind !== 'poll' || polls.length > 0),
            projectsMatched: matched.length,
          },
        });
        await tx.gitHubApp.update({
          where: { id: GITHUB_APP_ROW_ID },
          data: { lastDeliveryAt: now },
        });
        for (const poll of polls) {
          const project = poll.project;
          // D9 (spec notes): a negative seq of its own; the ack cursor never sees it.
          const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`
            SELECT -nextval('github_event_seq') AS seq`;
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

    return {
      answer: {
        status: routing.kind === 'ignore' ? 'ignored' : 'accepted',
      },
      work: {
        polls: polls.map((p) => ({
          projectId: p.project.id,
          collectors: p.collectors,
        })),
        resync: routing.kind === 'resync',
      },
    };
  }

  /** After the response: hands polls to the debouncer, starts a resync. */
  after(work: GitHubHookWork): void {
    for (const poll of work.polls)
      this.debouncer.request(poll.projectId, poll.collectors);
    if (work.resync) this.installations.resyncInBackground();
  }

  /** D7: projects on this repository, case-insensitively. */
  private projectsFor(fullName: string): Promise<MatchedProject[]> {
    return this.prisma.project.findMany({
      where: { repo: { equals: fullName, mode: 'insensitive' } },
      select: {
        id: true,
        runnerId: true,
        rootPath: true,
        repo: true,
        baseBranch: true,
        baseOverride: true,
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

/** A delivery id fit for a log line. */
const safeId = (id: string | undefined): string =>
  id && DELIVERY_ID.test(id) ? id : '(none)';
