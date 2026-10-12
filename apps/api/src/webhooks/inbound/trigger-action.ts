import {
  checkArgsTemplate,
  type InboundTriggerAction,
  inboundPayloadPathSchema,
  inboundTriggerActionSchema,
  isValidValuePattern,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { isRunnableSkill } from '@agentdock/shared/protocol';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { webhooksError } from '../common';

/**
 * D3: a request's or a stored action, parsed with the shared schema. The
 * orchestrator and worker skills have their own control path, so a skill
 * action naming one is refused like a malformed one (400).
 */
export const parseAction = (raw: unknown): InboundTriggerAction => {
  const parsed = inboundTriggerActionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(`action ${z.prettifyError(parsed.error)}`);
  }
  const action = parsed.data;
  if (action.kind === 'skill' && !isRunnableSkill(action.skill)) {
    throw new BadRequestException(
      `action.skill ${action.skill} has its own control path`,
    );
  }
  return action;
};

/**
 * D4 at create and update: every path is well formed, the pattern compiles,
 * and a skill action's args template parses and uses allowed paths only.
 * 422 `invalid_template` otherwise.
 */
export const checkTemplate = (
  action: InboundTriggerAction,
  allowedPaths: readonly string[],
  valuePattern: string | null,
): void => {
  const badPath = allowedPaths.find(
    (path) => !inboundPayloadPathSchema.safeParse(path).success,
  );
  if (badPath !== undefined) {
    throw webhooksError(
      422,
      WEBHOOKS_ERROR.invalidTemplate,
      'allowedPaths entries must be dotted segments of [A-Za-z0-9_-]',
      { path: badPath },
    );
  }
  if (valuePattern !== null && !isValidValuePattern(valuePattern)) {
    throw webhooksError(
      422,
      WEBHOOKS_ERROR.invalidTemplate,
      'valuePattern is not a valid regular expression',
    );
  }
  if (action.kind !== 'skill') return;
  const checked = checkArgsTemplate(action.args, allowedPaths);
  if (!checked.ok) {
    throw webhooksError(
      422,
      WEBHOOKS_ERROR.invalidTemplate,
      'action.args is not a valid template for allowedPaths',
      {
        reason: checked.reason,
        ...(checked.path !== undefined ? { path: checked.path } : {}),
      },
    );
  }
};
