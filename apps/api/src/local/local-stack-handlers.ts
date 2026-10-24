import type { TaskDesignView } from '@nautelle/shared';
import type {
  LocalDesignView,
  LocalMethodArgs,
  LocalMethodName,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { BoardDependencies } from '../board/board-dependencies.service';
import {
  localDesignBriefOf,
  localStackOf,
} from '../board/board-session.service';
import { BoardStackRuns } from '../board/board-stack-runs';
import { BoardStacks } from '../board/board-stacks';
import { DesignService } from '../design/design.service';
import type { PlanActor } from '../planner/plan.service';
import { actorOf } from './local-board-handlers';
import {
  type LocalCall,
  type LocalHandlerTable,
  projectOf,
} from './local-call';
import { LocalError } from './local-error';
import { LocalManualGate } from './local-manual-gate';

/** The stack, design and dependency methods of a person's session (C-377). */
export type LocalStackMethod = Extract<
  LocalMethodName,
  | 'stack.create'
  | 'stack.addCard'
  | 'stack.removeCard'
  | 'stack.update'
  | 'stack.run'
  | 'stack.stop'
  | 'stack.designView'
  | 'stack.design'
  | 'card.designView'
  | 'card.design'
  | 'card.depend'
  | 'card.undepend'
>;

type DesignArgs =
  | LocalMethodArgs<'stack.design'>
  | LocalMethodArgs<'card.design'>;

/** The design routes' calls for one owner, so both owners share one flow. */
interface DesignOwnerCalls {
  owner: LocalDesignView['owner'];
  number: number;
  view: () => Promise<TaskDesignView>;
  generate: (actor: PlanActor) => Promise<void>;
  comment: (
    revisionId: string,
    body: string,
    actor: PlanActor,
  ) => Promise<void>;
  revise: (actor: PlanActor) => Promise<void>;
  approve: (revisionId: string, actor: PlanActor) => Promise<void>;
}

/** A design as the design tools answer it. */
export const localDesignViewOf = (
  view: TaskDesignView,
  owner: LocalDesignView['owner'],
  number: number,
): LocalDesignView => ({
  ...localDesignBriefOf(view),
  owner,
  number,
  revisions: view.revisions.map((r) => ({
    id: r.id,
    variant: r.variant,
    revision: r.revision,
    title: r.title,
    archived: r.archived,
  })),
  openComments: view.comments
    .filter((c) => c.addressedInRevisionId === null)
    .map((c) => ({ id: c.id, revisionId: c.revisionId, body: c.body })),
  lastFailure: view.lastFailure
    ? { reason: view.lastFailure.reason, message: view.lastFailure.message }
    : null,
});

const revisionText = (r: TaskDesignView['revisions'][number]): string =>
  `${r.id} (variant ${r.variant}, revision ${r.revision})`;

/**
 * Approve without a `revisionId`: the newest revision of the only variant
 * still in play. Several variants are a person's pick — the tool names them.
 */
const approvedRevisionOf = (view: TaskDesignView): string => {
  const live = view.revisions.filter((r) => !r.archived);
  const variants = new Set(live.map((r) => r.variant));
  if (live.length === 0) {
    throw new LocalError('invalid_args', 'The design has no revision yet');
  }
  if (variants.size > 1) {
    const newest = [...variants].map(
      (v) => live.filter((r) => r.variant === v).at(-1) ?? live[0],
    );
    throw new LocalError(
      'invalid_args',
      `Name the revision to approve: ${newest.map(revisionText).join(', ')}`,
    );
  }
  return (live.at(-1) ?? live[0]).id;
};

/** Revise with comments and no `revisionId`: the newest revision still in play. */
const commentedRevisionOf = (view: TaskDesignView): string => {
  const live = view.revisions.filter((r) => !r.archived).at(-1);
  if (!live) {
    throw new LocalError('invalid_args', 'The design has no revision yet');
  }
  return live.id;
};

/**
 * C-377 (ADR-0089): stacks, designs and dependencies from a person's session.
 * Writes answer only a person's own `manual` session and act through the
 * services the web routes use, so every rule and refusal is the web app's.
 * The design views answer any session; Approve from any other session is
 * `needs_person` — it stays a person's gate.
 */
@Injectable()
export class LocalStackHandlers {
  constructor(
    private readonly stacks: BoardStacks,
    private readonly runs: BoardStackRuns,
    private readonly dependencies: BoardDependencies,
    private readonly designs: DesignService,
    private readonly gate: LocalManualGate,
  ) {}

  readonly table: Pick<LocalHandlerTable, LocalStackMethod> = {
    'stack.create': (args, call) =>
      this.gate.control(call, async () =>
        localStackOf(
          await this.stacks.groupStaged(
            projectOf(call).id,
            args,
            actorOf(call),
          ),
        ),
      ),
    'stack.addCard': (args, call) =>
      this.gate.control(call, async () =>
        localStackOf(
          await this.stacks.addCard(
            projectOf(call).id,
            args.stack,
            { card: args.card, stage: args.stage },
            actorOf(call),
          ),
        ),
      ),
    'stack.removeCard': (args, call) =>
      this.gate.control(call, async () =>
        localStackOf(
          await this.stacks.removeCard(
            projectOf(call).id,
            args.stack,
            args.card,
            actorOf(call),
          ),
        ),
      ),
    'stack.update': (args, call) =>
      this.gate.control(call, async () => {
        const { stack, ...change } = args;
        return localStackOf(
          await this.stacks.update(
            projectOf(call).id,
            stack,
            change,
            actorOf(call),
          ),
        );
      }),
    'stack.run': (args, call) =>
      this.gate.control(call, async () =>
        localStackOf(
          await this.runs.start(projectOf(call).id, args.stack, actorOf(call)),
        ),
      ),
    'stack.stop': (args, call) =>
      this.gate.control(call, async () =>
        localStackOf(
          await this.runs.stop(projectOf(call).id, args.stack, actorOf(call)),
        ),
      ),
    'stack.designView': async (args, call) =>
      localDesignViewOf(
        await this.designs.stackView(projectOf(call).id, args.stack),
        'stack',
        args.stack,
      ),
    'stack.design': (args, call) =>
      this.design(this.stackDesign(call, args.stack), args, call),
    'card.designView': async (args, call) =>
      localDesignViewOf(
        await this.designs.cardView(projectOf(call).id, args.card, call.role),
        'card',
        args.card,
      ),
    'card.design': (args, call) =>
      this.design(this.cardDesign(call, args.card), args, call),
    'card.depend': (args, call) =>
      this.gate.control(call, async () => {
        const view = await this.dependencies.add(
          projectOf(call).id,
          args.card,
          args.dependsOn,
          actorOf(call),
        );
        return {
          number: args.card,
          dependsOn: view.dependsOn.map((d) => d.number),
        };
      }),
    'card.undepend': (args, call) =>
      this.gate.control(call, async () => {
        const view = await this.dependencies.remove(
          projectOf(call).id,
          args.card,
          args.dependsOn,
          actorOf(call),
        );
        return {
          number: args.card,
          dependsOn: view.dependsOn.map((d) => d.number),
        };
      }),
  };

  private stackDesign(call: LocalCall, number: number): DesignOwnerCalls {
    const projectId = projectOf(call).id;
    return {
      owner: 'stack',
      number,
      view: () => this.designs.stackView(projectId, number),
      generate: (actor) => this.designs.stackGenerate(projectId, number, actor),
      comment: (revisionId, body, actor) =>
        this.designs.stackComment(
          projectId,
          number,
          { revisionId, kind: 'general', body },
          actor,
        ),
      revise: (actor) => this.designs.stackRevise(projectId, number, actor),
      approve: (revisionId, actor) =>
        this.designs.stackApprove(projectId, number, revisionId, actor),
    };
  }

  private cardDesign(call: LocalCall, number: number): DesignOwnerCalls {
    const projectId = projectOf(call).id;
    return {
      owner: 'card',
      number,
      view: () => this.designs.cardView(projectId, number),
      generate: (actor) => this.designs.cardGenerate(projectId, number, actor),
      comment: (revisionId, body, actor) =>
        this.designs.cardComment(
          projectId,
          number,
          { revisionId, kind: 'general', body },
          actor,
        ),
      revise: (actor) => this.designs.cardRevise(projectId, number, actor),
      approve: async (revisionId, actor) => {
        await this.designs.cardApprove(projectId, number, revisionId, actor);
      },
    };
  }

  /**
   * Generate, Revise or Approve as the design page does: the design routes
   * check needed, busy, frozen, open comments and the revision. Approve from a
   * session that is not a person's own is `needs_person`.
   */
  private async design(
    calls: DesignOwnerCalls,
    args: DesignArgs,
    call: LocalCall,
  ): Promise<LocalDesignView> {
    if (args.action !== 'revise' && args.comments !== undefined) {
      throw new LocalError('invalid_args', 'comments go with revise only');
    }
    const refusal =
      args.action === 'approve'
        ? () =>
            new LocalError(
              'needs_person',
              "Approving a design is a person's: approve it in the web app",
            )
        : undefined;
    return this.gate.control(
      call,
      async () => {
        const actor = this.planActorOf(call);
        if (args.action === 'generate') {
          await calls.generate(actor);
        } else if (args.action === 'revise') {
          if (args.comments) {
            const revisionId =
              args.revisionId ?? commentedRevisionOf(await calls.view());
            for (const body of args.comments) {
              await calls.comment(revisionId, body, actor);
            }
          }
          await calls.revise(actor);
        } else {
          const revisionId =
            args.revisionId ?? approvedRevisionOf(await calls.view());
          await calls.approve(revisionId, actor);
        }
        return localDesignViewOf(await calls.view(), calls.owner, calls.number);
      },
      refusal,
    );
  }

  private planActorOf(call: LocalCall): PlanActor {
    return { userId: call.user.id, role: call.role, ctx: call.ctx };
  }
}
