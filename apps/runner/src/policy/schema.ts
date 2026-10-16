import {
  absolutePathSchema,
  orchestratorPermissionModeSchema,
  POLICY_ALLOWED_ROOTS_MAX,
  POLICY_DEFAULT_MAX_PERMISSION_MODE,
  POLICY_GATED_COMMANDS,
  type PolicyGatedCommand,
  type RunnerPolicy,
} from '@agentdock/shared/protocol';
import { z } from 'zod';

const gatedCommandsShape = Object.fromEntries(
  POLICY_GATED_COMMANDS.map((name) => [name, z.boolean().default(false)]),
) as Record<PolicyGatedCommand, z.ZodDefault<z.ZodBoolean>>;

/**
 * The `policy` block of `runner.json` (ADR-0046). Every field defaults to the
 * safe value: no allowed root, nothing above `auto`, no terminal write, no
 * profile skill install, no gated command. Only `agentdock-runner policy …`
 * and `pair --allow-root` write it; the daemon only reads it.
 */
export const policyConfigSchema = z
  .object({
    allowedRoots: z
      .array(absolutePathSchema)
      .max(POLICY_ALLOWED_ROOTS_MAX)
      .default([]),
    maxPermissionMode: orchestratorPermissionModeSchema.default(
      POLICY_DEFAULT_MAX_PERMISSION_MODE,
    ),
    terminal: z.object({ write: z.boolean().default(false) }).prefault({}),
    skills: z
      .object({ profileInstall: z.boolean().default(false) })
      .prefault({}),
    commands: z.strictObject(gatedCommandsShape).prefault({}),
  })
  .prefault({});
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

/** The safe defaults, used whenever the config cannot be read. */
export const defaultPolicy = (): PolicyConfig => policyConfigSchema.parse({});

/** The policy as `hello` reports it (`runnerPolicySchema`). */
export const reportedPolicy = (policy: PolicyConfig): RunnerPolicy => ({
  allowedRoots: [...policy.allowedRoots],
  maxPermissionMode: policy.maxPermissionMode,
  terminal: { write: policy.terminal.write },
  skills: { profileInstall: policy.skills.profileInstall },
  commands: { ...policy.commands },
});
