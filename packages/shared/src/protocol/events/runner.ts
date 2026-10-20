import { z } from 'zod';
import {
  boundedName,
  LIST_MAX,
  TEXT_NAME_MAX,
  TEXT_PATH_MAX,
} from '../bounded';

/**
 * The projects of the watch list the runner-local policy refuses (#691,
 * ADR-0047). `source: "runner"`, no envelope `project`: one event names the
 * whole refused set. The runner sends it whenever that set changes, and once
 * per start, so `projects: []` clears what an earlier one reported.
 */
export const WATCH_REFUSED_EVENT = 'runner.watch_refused';

/**
 * One refused project. `message` has the shape of every `policy_refused`
 * message — `refused by this runner's policy (<rule>): <why>. On the
 * runner's machine: \`<command>\`` — so the web reads the rule, the reason
 * and the exact command out of it as it does for a refused command.
 */
export const watchRefusalSchema = z.object({
  projectId: boundedName(TEXT_NAME_MAX),
  // The reason and the command each may name the root.
  message: z
    .string()
    .min(1)
    .max(3 * TEXT_PATH_MAX),
});
export type WatchRefusal = z.infer<typeof watchRefusalSchema>;

export const watchRefusedDataSchema = z.object({
  projects: z.array(watchRefusalSchema).max(LIST_MAX),
});
export type WatchRefusedData = z.infer<typeof watchRefusedDataSchema>;
