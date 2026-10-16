import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDOFF_UPDATED_EVENT,
  handoffUpdatedDataSchema,
} from '@agentdock/shared';
import {
  PLAN_TURN_PROMPT_MAX_BYTES,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { type Clock, isoNow } from '../clock';
import type { ConfigProfile } from '../config';
import { errorMessage, type Logger } from '../log';
import type { HandoffWriter } from './haiku';
import { judgeNote, readNoteFile } from './note';
import { RUN_HANDOFF_FILE } from './state';
import { readTranscript, transcriptExcerpt } from './transcript';

/**
 * #449 D1, D2, D4: notes of long runner runs — a design (`uiprofile`) build
 * and a planner turn (#494). Such a run is headless and read-only
 * (`--permission-mode plan`), so its agent cannot keep a note: when it is
 * interrupted, haiku writes one from its `stream.jsonl` into
 * `<run dir>/handoff.md`, and the same work started again — the same project
 * and the same prompt, i.e. the same revision or plan task — starts from it
 * instead of from zero. A run that succeeds clears it.
 */

/** What the run notes need of a run. */
export interface HandoffRun {
  projectId: string;
  runId: string;
  repo: string;
  root: string;
  profileKey: string;
}

export interface RunNotesOptions {
  /** Where notes wait for the run that picks them up, by work. */
  dir: string;
  writer: HandoffWriter;
  profiles: () => readonly ConfigProfile[];
  watchedProjects: () => readonly WatchedProject[];
  emit: (event: UnsequencedEvent) => void;
  clock: Clock;
  log: Logger;
}

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** The same work: the project and the prompt, hashed. */
export const runWorkKey = (projectId: string, prompt: string): string =>
  createHash('sha256').update(`${projectId}\0${prompt}`).digest('hex');

/** The prompt of a run that picks up an interrupted attempt's note. */
export const runSeedPrompt = (prompt: string, note: string): string =>
  [
    prompt.trimEnd(),
    '',
    '## Handoff from an interrupted attempt',
    '',
    'An earlier attempt at exactly this task was interrupted. Its handoff note is below: continue from "Next", do not redo "Done", do not retry "Dead ends".',
    '',
    '<handoff-note>',
    note.trimEnd(),
    '</handoff-note>',
    '',
  ].join('\n');

export class RunNotes {
  constructor(private readonly options: RunNotesOptions) {}

  /**
   * The prompt to start with: `prompt`, plus the note of an interrupted
   * attempt at the same work when there is one and it fits.
   */
  seed(key: string, prompt: string): string {
    const file = readNoteFile(this.keyed(key));
    if (!file) return prompt;
    const judged = judgeNote(file.text, null);
    if (judged.kind !== 'accepted') return prompt;
    const seeded = runSeedPrompt(prompt, judged.content);
    return utf8Bytes(seeded) <= PLAN_TURN_PROMPT_MAX_BYTES ? seeded : prompt;
  }

  /** The run succeeded: the work needs no note any more. */
  succeeded(key: string): void {
    rmSync(this.keyed(key), { force: true });
  }

  /**
   * D2: an interrupted run's note, by haiku from its stream — written to
   * `<run dir>/handoff.md` and kept for the next attempt at the same work.
   */
  async interrupted(
    run: HandoffRun,
    key: string,
    runDir: string,
    streamFile: string,
  ): Promise<void> {
    try {
      const profile = this.options
        .profiles()
        .find((p) => p.id === run.profileKey);
      const stream = readTranscript(streamFile);
      if (!profile || !stream) return;
      const excerpt = transcriptExcerpt(stream);
      if (!excerpt) return;
      const previous = readNoteFile(this.keyed(key));
      const written = await this.options.writer.write(
        profile,
        run.projectId,
        excerpt,
        previous?.text ?? null,
      );
      if (!written) return;
      const judged = judgeNote(written, null);
      if (judged.kind !== 'accepted') return;
      const text = `${judged.content.trimEnd()}\n`;
      writeFileSync(join(runDir, RUN_HANDOFF_FILE), text, { mode: 0o600 });
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.keyed(key), text, { mode: 0o600 });
      this.report(run, judged.content);
    } catch (error) {
      this.options.log.warn('handoff: the run note failed', {
        runId: run.runId,
        error: errorMessage(error),
      });
    }
  }

  private report(run: HandoffRun, content: string): void {
    const project = this.options
      .watchedProjects()
      .find((p) => p.id === run.projectId && p.root === run.root);
    // D4, ADR-0021: the note leaves the machine only with session content on.
    if (project?.shipContent !== true) return;
    const at = isoNow(this.options.clock);
    const data = handoffUpdatedDataSchema.parse({
      projectId: run.projectId,
      at,
      subject: { kind: 'run', runId: run.runId },
      updatedBy: 'haiku',
      content,
      personLines: [],
    });
    this.options.emit({
      v: 1,
      ts: at,
      type: HANDOFF_UPDATED_EVENT,
      source: 'runner',
      project: { repo: run.repo, root: run.root },
      data,
    });
  }

  private keyed(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('not a run work key');
    return join(this.options.dir, `${key}.md`);
  }
}
