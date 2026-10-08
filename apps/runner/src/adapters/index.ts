import type { Runtime } from '@agentdock/shared/protocol';
import { claudeAdapter } from './claude/adapter';
import { codexAdapter } from './codex/adapter';
import type { RuntimeAdapter } from './types';

export * from './types';
export {
  type BackfillScope,
  SessionWatcher,
  type SessionWatcherOptions,
} from './watcher';

/** One adapter per runtime (D1); a profile is read by the adapter of its runtime. */
export const adapters: Record<Runtime, RuntimeAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
