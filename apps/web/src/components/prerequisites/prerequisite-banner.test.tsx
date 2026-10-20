import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WatchRefusalBanner } from './prerequisite-banner';

describe('WatchRefusalBanner (#691)', () => {
  test('shows that the runner refuses the project and the command that fixes it', () => {
    const html = renderToStaticMarkup(
      <WatchRefusalBanner
        project={{
          runnerName: 'laptop',
          runnerStatus: 'online',
          watchRefusal:
            "refused by this runner's policy (allowedRoots): this runner allows no project root yet. On the runner's machine: `nautelle-runner policy allow-root /srv/dev/widget`",
        }}
      />,
    );
    expect(html).toContain('Runner laptop refuses to watch this project.');
    expect(html).toContain('This runner allows no project root yet.');
    expect(html).toContain('nautelle-runner policy allow-root /srv/dev/widget');
    expect(html).toContain('nautelle-runner policy allow-root --watched');
  });

  test('renders nothing while the runner watches the project', () => {
    expect(
      renderToStaticMarkup(
        <WatchRefusalBanner
          project={{
            runnerName: 'laptop',
            runnerStatus: 'online',
            watchRefusal: null,
          }}
        />,
      ),
    ).toBe('');
  });
});
