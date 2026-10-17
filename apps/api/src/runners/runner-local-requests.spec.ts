import {
  LOCAL_MAX_CONCURRENT_PER_RUNNER,
  type LocalRequestMessage,
  type LocalResponseMessage,
} from '@agentdock/shared/protocol';
import { RunnerLocalRequests } from './runner-local-requests';

const request = (id: string): LocalRequestMessage =>
  ({ type: 'local.request', id, method: 'status', args: {} }) as never;

const ok = (id: string): LocalResponseMessage =>
  ({ type: 'local.response', id, ok: true, result: {} }) as never;

describe('RunnerLocalRequests (C-137)', () => {
  const setup = () => {
    const pending: (() => void)[] = [];
    const requests = new RunnerLocalRequests();
    requests.register({
      answer: (_runnerId, message) =>
        new Promise((resolve) => pending.push(() => resolve(ok(message.id)))),
    });
    return { requests, pending };
  };

  it('refuses the 33rd concurrent request from one runner with busy', async () => {
    const { requests, pending } = setup();
    const inFlight = Array.from(
      { length: LOCAL_MAX_CONCURRENT_PER_RUNNER },
      (_, i) => requests.answer('rn_1', request(`r${i}`)),
    );
    const refused = await requests.answer('rn_1', request('r-extra'));
    expect(refused).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(pending).toHaveLength(LOCAL_MAX_CONCURRENT_PER_RUNNER);

    // Another runner is not affected.
    const other = requests.answer('rn_2', request('o1'));
    expect(pending).toHaveLength(LOCAL_MAX_CONCURRENT_PER_RUNNER + 1);

    // A finished request frees a slot.
    pending[0]();
    await inFlight[0];
    const again = requests.answer('rn_1', request('r-again'));
    expect(pending).toHaveLength(LOCAL_MAX_CONCURRENT_PER_RUNNER + 2);

    for (const done of pending) done();
    await Promise.all([...inFlight, other, again]);
  });
});
