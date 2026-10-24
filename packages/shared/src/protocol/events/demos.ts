import { z } from 'zod';
import {
  DEMO_REASON_MAX,
  demoIdSchema,
  demoScenarioPathSchema,
} from '../../demos/contracts';
import { cardIdSchema } from '../commands/cards';

/**
 * Demo recording events (C-368, ADR-0089). A recording outlives the
 * `card.demo` command that started it, so its progress travels in the event
 * stream. `source: "runner"`; `data.projectId` repeats the envelope's project.
 *
 * `ready` is not an event: the video's upload (`runnerDemoVideoPath`) is what
 * makes a demo ready, so a ready demo always has its video.
 */

/** The statuses a runner reports; the API moves a demo only while it is active. */
export const DEMO_EVENT_STATUSES = ['recording', 'failed', 'skipped'] as const;

export const demoStatusDataSchema = z
  .object({
    cardId: cardIdSchema,
    projectId: z.string().min(1),
    demoId: demoIdSchema,
    status: z.enum(DEMO_EVENT_STATUSES),
    at: z.iso.datetime(),
    /** The scenario the runner found, once it found one. */
    scenarioPath: demoScenarioPathSchema.optional(),
    /** Why it failed or was skipped, without a stack trace or a secret. */
    reason: z.string().min(1).max(DEMO_REASON_MAX).optional(),
  })
  .refine((d) => d.status === 'recording' || d.reason !== undefined, {
    message: 'a failed or skipped demo carries reason',
    path: ['reason'],
  });
export type DemoStatusData = z.infer<typeof demoStatusDataSchema>;

/** `data` schema of every demo event type. */
export const demoEventDataSchemas = {
  'demo.status': demoStatusDataSchema,
} as const;

export type DemoEventType = keyof typeof demoEventDataSchemas;

export const isDemoEventType = (type: string): type is DemoEventType =>
  Object.hasOwn(demoEventDataSchemas, type);
