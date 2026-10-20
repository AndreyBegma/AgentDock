import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import {
  AGENTDOCK_WORKTREE_DIR,
  ATTACHMENTS_WORKTREE_DIR,
  type AttachmentRef,
  attachmentFileName,
  runnerAttachmentPath,
} from '@nautelle/shared';
import { CommandFailure } from '../commands/failure';
import { errorMessage } from '../log';
import { normalizeServer } from '../server-url';
import { excludeFromGit, type GitDeps } from './git';
import { modelImage } from './model-image';

/** Where and as whom the runner reads attachments (#309 D9). */
export interface AttachmentSource {
  /** The API origin the runner is paired with. */
  server: string;
  insecureServer?: boolean;
  /** The runner's own token — sent only to `server`. */
  token: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 120_000;
const PARALLEL_DOWNLOADS = 4;
/** A half-written file; pruned like any unlisted file. */
const TEMP_PREFIX = '.tmp-';

const unavailable = (message: string): CommandFailure =>
  new CommandFailure('attachments_unavailable', message);

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** `bytes` is exactly what `ref` promised: its size and its SHA-256. */
const matches = (ref: AttachmentRef, bytes: Uint8Array): boolean =>
  bytes.byteLength === ref.size && sha256Of(bytes) === ref.sha256;

/**
 * Reads the body, stopping as soon as it passes the size `ref` promised, so a
 * server cannot make the runner buffer more than the contract allows.
 */
const readBody = async (
  response: Response,
  ref: AttachmentRef,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw unavailable(`attachment ${ref.id} has no body`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ref.size) {
      await reader.cancel();
      throw unavailable(
        `attachment ${ref.id} is larger than ${ref.size} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const download = async (
  source: AttachmentSource,
  ref: AttachmentRef,
): Promise<Uint8Array> => {
  const url = `${normalizeServer(source.server, source.insecureServer)}${runnerAttachmentPath(ref.id)}`;
  let response: Response;
  try {
    response = await (source.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${source.token}` },
      // The token must never follow a redirect to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(
        source.timeoutMs ?? ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    throw unavailable(
      `attachment ${ref.id} could not be fetched: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw unavailable(`attachment ${ref.id}: HTTP ${response.status}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBody(response, ref);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw unavailable(
      `attachment ${ref.id} could not be read: ${errorMessage(error)}`,
    );
  }
  if (!matches(ref, bytes)) {
    throw unavailable(
      `attachment ${ref.id} does not match its size and SHA-256`,
    );
  }
  return bytes;
};

/** The attachments directory, created inside the worktree and never through a symlink. */
const ensureDirectory = (worktree: string): string => {
  const top = realpathSync(worktree);
  const dir = join(top, ATTACHMENTS_WORKTREE_DIR);
  for (const part of [AGENTDOCK_WORKTREE_DIR, ATTACHMENTS_WORKTREE_DIR]) {
    const path = join(top, part);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw unavailable(`${part} in the card's worktree is a symlink`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (real !== dir && !real.startsWith(`${top}${sep}`)) {
    throw unavailable("the attachments directory leaves the card's worktree");
  }
  return real;
};

/**
 * #628: beside the attachments directory, what each file a model reads was
 * made from — the source's SHA-256 and the written file's — so a scaled
 * image is not downloaded again on every turn.
 */
const MODEL_MANIFEST = 'attachments-model.json';
type ModelManifest = Record<string, { source: string; sha256: string }>;

const readManifest = (file: string): ModelManifest => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as ModelManifest)
      : {};
  } catch {
    return {};
  }
};

/**
 * True when `file` already holds what `ref` promised — exactly, or (#628)
 * as the manifest says the model copy of it was written.
 */
const present = (
  file: string,
  ref: AttachmentRef,
  model: ModelManifest[string] | null,
): boolean => {
  try {
    if (!lstatSync(file).isFile()) return false;
    const bytes = new Uint8Array(readFileSync(file));
    if (model === null) return matches(ref, bytes);
    return model.source === ref.sha256 && sha256Of(bytes) === model.sha256;
  } catch {
    return false;
  }
};

const writeAtomic = (dir: string, name: string, bytes: Uint8Array): void => {
  const temp = join(dir, `${TEMP_PREFIX}${name}`);
  writeFileSync(temp, bytes, { mode: 0o644 });
  renameSync(temp, join(dir, name));
};

const inPool = async <T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = [...items];
  let failure: unknown;
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (failure) return;
      try {
        await fn(item);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failure) throw failure;
};

export interface SyncAttachmentsOptions {
  /**
   * #628: the files are only read by a model — a plan or design turn — so
   * an image is scaled to the size the model reads (`modelImage`). A card's
   * worktree keeps the originals: its worker may commit one.
   */
  forModel?: boolean;
}

/**
 * #309 D9: makes `<worktree>/.agentdock/attachments/` hold exactly `refs`.
 * A file already there with the right size and SHA-256 is kept; every other
 * listed file is downloaded, checked and written atomically; unlisted files
 * (and half-written ones) are removed; `.agentdock/` is git-excluded. Any
 * failure is `attachments_unavailable` — the round must not start without
 * what the person attached.
 */
export const syncAttachments = async (
  deps: GitDeps,
  worktree: string,
  refs: readonly AttachmentRef[],
  source: AttachmentSource | undefined,
  options: SyncAttachmentsOptions = {},
): Promise<void> => {
  const directory = join(worktree, ATTACHMENTS_WORKTREE_DIR);
  if (refs.length === 0 && !existsSync(directory)) return;
  try {
    const dir = ensureDirectory(worktree);
    await excludeFromGit(deps, worktree, `${AGENTDOCK_WORKTREE_DIR}/`);
    const wanted = new Map(
      refs.map((ref) => [attachmentFileName(ref.id, ref.name), ref]),
    );
    for (const entry of readdirSync(dir)) {
      if (!wanted.has(entry))
        rmSync(join(dir, entry), { recursive: true, force: true });
    }
    const manifestFile = join(dir, '..', MODEL_MANIFEST);
    const before = options.forModel ? readManifest(manifestFile) : {};
    const manifest: ModelManifest = {};
    const missing = [...wanted].filter(([name, ref]) => {
      const model = options.forModel
        ? (before[name] ?? { source: '', sha256: '' })
        : null;
      if (!present(join(dir, name), ref, model)) return true;
      if (model) manifest[name] = model;
      return false;
    });
    if (missing.length > 0 && !source) {
      throw unavailable('this runner has no way to download attachments');
    }
    await inPool(missing, PARALLEL_DOWNLOADS, async ([name, ref]) => {
      if (!source) return;
      const bytes = await download(source, ref);
      if (!options.forModel) {
        writeAtomic(dir, name, bytes);
        return;
      }
      const model = await modelImage(bytes, ref.mime);
      writeAtomic(dir, name, model);
      manifest[name] = { source: ref.sha256, sha256: sha256Of(model) };
    });
    if (options.forModel) {
      writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o644 });
    }
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw unavailable(
      `attachments could not be prepared: ${errorMessage(error)}`,
    );
  }
};
