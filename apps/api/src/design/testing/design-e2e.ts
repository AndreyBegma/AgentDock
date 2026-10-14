import { PLANNER_DESIGN_BLOCK_TAG } from '@agentdock/shared';
import type { UiProfileCommandName } from '@agentdock/shared/protocol';
import type { PlannerSendResult } from '../../planner/planner-commands';
import {
  block,
  ok,
  PlannerHarness,
  ROOT,
} from '../../planner/testing/planner-e2e';
import { DesignCommands } from '../design-commands';

/** A SHA-256 hex digest, as `uiprofile.fingerprint` answers. */
export const hash = (char: string): string => char.repeat(64);

/** A minimal valid mockup. */
export const MOCKUP =
  '<!doctype html><html lang="en" data-theme="light"><head><style>:root[data-theme="dark"]{color-scheme:dark}</style></head><body><main id="app"><button>Export</button></main></body></html>';

/** A design turn's final message: the plan block and one design block (D7). */
export const designResult = (
  output: {
    taskKey: string;
    variant: number;
    title?: string;
    rationale?: string;
    addressed?: string[];
  },
  html: string = MOCKUP,
): string =>
  `${block({
    action: 'design',
    taskKey: output.taskKey,
    variant: output.variant,
    title: output.title ?? `Variant ${output.variant}`,
    rationale: output.rationale ?? 'A single column.',
    addressed: output.addressed ?? [],
  })}\n\`\`\`\`${PLANNER_DESIGN_BLOCK_TAG}\n${html}\n\`\`\`\`\n`;

/** A profile build's final message (`profile` action). */
export const profileResult = (over: Record<string, unknown> = {}): string =>
  block({
    action: 'profile',
    hasUi: true,
    summary: 'PROFILE SUMMARY: React 19, Tailwind 4, glass-ui.',
    kit: ':root[data-theme="light"]{--accent:#3b82f6} /* PROFILE KIT */',
    snippets: [{ name: 'button', html: '<button class="btn">Go</button>' }],
    fingerprintGlobs: ['apps/web/src/styles/**'],
    ...over,
  });

type Handler = (args: unknown) => PlannerSendResult<unknown>;

/**
 * The planner harness with the profile commands stubbed as well:
 * `uiprofile.build` queues, `uiprofile.fingerprint` answers `fingerprint`.
 * Build results arrive as `uiprofile_build.*` events through the real sinks.
 */
export class DesignHarness extends PlannerHarness {
  designCommands!: DesignCommands;
  fingerprint = hash('a');
  designHandlers: Partial<Record<UiProfileCommandName, Handler>> = {};

  async start(): Promise<void> {
    await super.start();
    this.designCommands = this.ctx.app.get(DesignCommands);
  }

  async reset(): Promise<void> {
    await super.reset();
    this.fingerprint = hash('a');
    this.designHandlers = {
      'uiprofile.build': () => ok({ phase: 'queued' }),
      'uiprofile.fingerprint': () =>
        ok({ fingerprint: this.fingerprint, files: 3 }),
    };
    jest.spyOn(this.designCommands, 'assertReady').mockImplementation(() => {});
    jest
      .spyOn(this.designCommands, 'send')
      .mockImplementation(async (_runner, name, args) => {
        this.sent.push({
          name: name as never,
          args: args as Record<string, unknown>,
        });
        const handler = this.designHandlers[name];
        if (!handler) throw new Error(`no handler for ${name}`);
        return handler(args) as never;
      });
  }

  designBase(planId: string, key: string): string {
    return `${this.base(planId)}/tasks/${key}/design`;
  }

  /** The project's running profile build. */
  activeBuild() {
    return this.ctx.prisma.run.findFirstOrThrow({
      where: {
        projectId: this.projectId,
        kind: 'ui_profile',
        status: 'running',
      },
    });
  }

  /** The runner reports the running build finished with `resultText`. */
  async finishBuild(
    resultText: string,
    phase: 'succeeded' | 'failed' = 'succeeded',
  ): Promise<void> {
    const run = await this.activeBuild();
    await this.sinks.dispatch(this.runnerId, [
      this.event('uiprofile_build.finished', {
        runId: run.id,
        projectId: this.projectId,
        phase,
        at: new Date().toISOString(),
        exitCode: 0,
        resultText,
        resultTruncated: false,
      }),
    ]);
  }

  /** A profile version written straight to the database. */
  seedProfile(
    over: {
      hasUi?: boolean;
      globs?: string[];
      fingerprint?: string;
      version?: number;
    } = {},
  ) {
    return this.ctx.prisma.uiProfile.create({
      data: {
        projectId: this.projectId,
        version: over.version ?? 1,
        source: 'agent',
        hasUi: over.hasUi ?? true,
        summary: 'SEEDED SUMMARY',
        kit: ':root{--seeded:1}',
        snippets: [{ name: 'card', html: '<div class="card">Card</div>' }],
        fingerprintGlobs: over.globs ?? ['src/styles/**'],
        fingerprint: over.fingerprint ?? hash('a'),
      },
    });
  }

  /** The args of every profile command `name` sent, oldest first. */
  designSent(name: UiProfileCommandName): Record<string, unknown>[] {
    const wanted: string = name;
    return this.sent.filter((c) => c.name === wanted).map((c) => c.args);
  }

  /** The prompts of the `plan.turn` commands sent, oldest first. */
  turnPrompts(): string[] {
    return this.sentOf('plan.turn').map((a) => String(a.prompt));
  }
}

export { ROOT };
