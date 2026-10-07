import { z } from 'zod';

export const runtimeSchema = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof runtimeSchema>;

const portSchema = z.number().int().min(1).max(65_535);

/**
 * A runtime profile: runtime + binary + environment + extra args (ADR-0006).
 * Defined in the runner config; the server mirrors it, never edits it.
 */
export const runtimeProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  runtime: runtimeSchema,
  /** Executable to launch; the runtime's own name when absent. */
  binary: z.string().min(1).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  args: z.array(z.string()),
  authenticated: z.boolean(),
});
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

const runtimeVersionSchema = z.object({ version: z.string().min(1) });

/** What the runner found on the machine. A missing tool is `null`, never an error. */
export const capabilitiesSchema = z.object({
  tmux: z.string().min(1).nullable(),
  git: z.string().min(1).nullable(),
  gh: z
    .object({
      version: z.string().min(1),
      authenticated: z.boolean(),
      user: z.string().min(1).nullable(),
    })
    .nullable(),
  runtimes: z.object({
    claude: runtimeVersionSchema.nullable(),
    codex: runtimeVersionSchema.nullable(),
  }),
  profiles: z.array(runtimeProfileSchema),
  codeSentinel: z
    .object({ version: z.string().min(1), path: z.string().min(1) })
    .nullable(),
  /** OTLP receiver ports (reserved until collectors land). */
  otlp: z
    .object({ grpc: portSchema.nullable(), http: portSchema.nullable() })
    .nullable(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** Facts about the host itself, sent next to the capabilities. */
export const hostSchema = z.object({
  hostname: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
});
export type Host = z.infer<typeof hostSchema>;
