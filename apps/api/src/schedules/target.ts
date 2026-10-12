import { SCHEDULES_ERROR, type ScheduleTarget } from '@agentdock/shared';
import {
  isRunnableSkill,
  orchestratorModeSchema,
  skillArgsTextSchema,
  skillInvocationSchema,
  skillRunOutputSchema,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { schedulesError } from './schedules-error';

/** The model rule of the protocol: an alias or id, never a flag. */
const modelSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/, 'must be a model alias or id');

/**
 * D1: the closed union of what a schedule may fire, checked with the
 * protocol's own schemas. Nothing else is schedulable (ADR-0010).
 */
export const scheduleTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('skill'),
    skill: skillInvocationSchema.refine(isRunnableSkill, {
      message: 'the orchestrator and worker skills have their own control path',
    }),
    args: skillArgsTextSchema,
    profileId: z.string().min(1).max(64).optional(),
    model: modelSchema.optional(),
    output: skillRunOutputSchema,
  }),
  z.strictObject({
    kind: z.literal('orchestrator'),
    mode: orchestratorModeSchema,
  }),
]);

/** A request's or a stored target, parsed; 422 `invalid_target` otherwise. */
export const parseTarget = (raw: unknown): ScheduleTarget => {
  const parsed = scheduleTargetSchema.safeParse(raw);
  if (!parsed.success) {
    throw schedulesError(
      422,
      SCHEDULES_ERROR.invalidTarget,
      `target ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
};
