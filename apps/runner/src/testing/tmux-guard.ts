import { afterAll } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { leakedSockets, socketDir } from './tmux';

/**
 * Preloaded by `bun test` (see `bunfig.toml`): after every spec file, no socket
 * of a private tmux server this run started may remain. A leftover is swept and
 * fails the file, so a spec that forgets `releaseTmuxServer` cannot go
 * unnoticed.
 */
afterAll(() => {
  const leaked = leakedSockets(process.pid);
  for (const name of leaked) {
    Bun.spawnSync(['tmux', '-L', name, 'kill-server']);
    rmSync(join(socketDir(), name), { force: true });
  }
  if (leaked.length > 0) {
    throw new Error(
      `tmux sockets left behind: ${leaked.join(', ')}. ` +
        'Tear the server down with releaseTmuxServer (src/testing/tmux.ts).',
    );
  }
});
