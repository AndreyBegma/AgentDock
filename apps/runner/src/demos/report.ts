import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MASK } from '../pane/redact';
import { boundedReason } from './provision';

/**
 * C-369: the summary `demoflow run --json` prints on stdout — one JSON line,
 * schema version 1 (DemoFlow 0.4.0). Only what the runner reads is checked;
 * DemoFlow may add fields.
 */
const stageSchema = z.object({
  status: z.string(),
  error: z
    .object({
      message: z.string(),
      stepIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const DEMOFLOW_STAGES = [
  'readiness',
  'execution',
  'verification',
  'recording',
  'rendering',
  'storage',
] as const;

export const demoflowSummarySchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['completed', 'completed_with_warnings', 'failed', 'running']),
  stages: z.partialRecord(z.enum(DEMOFLOW_STAGES), stageSchema),
  renders: z.array(
    z.object({
      format: z.string(),
      /** Relative to `runDir`. */
      file: z.string().min(1),
      durationMs: z.number().nonnegative().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
    }),
  ),
  runDir: z.string().min(1),
});
export type DemoflowSummary = z.infer<typeof demoflowSummarySchema>;

/** The last stdout line that is a summary; DemoFlow prints nothing else there. */
export const parseSummary = (stdout: string): DemoflowSummary | null => {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = demoflowSummarySchema.safeParse(JSON.parse(lines[i]));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return null;
};

/**
 * Every secret value replaced by the mask, then the pane redaction, then the
 * reason bound. DemoFlow already scrubs `valueFrom.env` values; this covers
 * a dev server that prints one.
 */
export const maskedReason = (
  text: string,
  secrets: readonly string[],
): string => {
  let masked = text;
  // Longest first, so a value that contains another is masked whole.
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) {
    if (value.length > 0) masked = masked.split(value).join(MASK);
  }
  return boundedReason(masked);
};

/**
 * Why a run failed, from its summary: the first stage that failed, the step
 * it failed at, and DemoFlow's message. Never a `fill` value: DemoFlow does
 * not put them in stage errors, and the secrets are masked anyway.
 */
export const failureReason = (
  summary: DemoflowSummary,
  secrets: readonly string[],
): string => {
  for (const stage of DEMOFLOW_STAGES) {
    const result = summary.stages[stage];
    if (result?.status !== 'failed') continue;
    const step =
      result.error?.stepIndex !== undefined
        ? ` at step ${result.error.stepIndex + 1}`
        : '';
    const message = result.error?.message ?? 'no message';
    return maskedReason(`DemoFlow ${stage} failed${step}: ${message}`, secrets);
  }
  return `DemoFlow ended ${summary.status} without a failed stage`;
};

/** The MP4 a successful run rendered, as a path inside `outDir`; else null. */
export const renderedVideo = (
  summary: DemoflowSummary,
  outDir: string,
): { path: string; durationMs: number | null } | null => {
  const render = summary.renders.find((r) => r.format === 'mp4');
  if (!render) return null;
  const path = resolve(summary.runDir, render.file);
  const inside = relative(resolve(outDir), path);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  return {
    path,
    durationMs:
      render.durationMs !== undefined ? Math.round(render.durationMs) : null,
  };
};
