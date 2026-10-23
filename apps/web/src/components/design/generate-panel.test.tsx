import { describe, expect, test } from 'bun:test';
import { STACK_GATE_REASON } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { design } from '../../lib/design/fixtures';
import { UserProvider } from '../shell/user-context';
import { GeneratePanel } from './generate-panel';

const render = (stackBlock: string | null) =>
  renderToStaticMarkup(
    <UserProvider
      value={{
        id: 'u1',
        email: 'op@example.com',
        name: null,
        role: 'operator',
        status: 'active',
        twoFactorEnabled: false,
      }}
    >
      <GeneratePanel
        projectId="p1"
        design={design({ revisions: [], status: 'idle', profileId: null })}
        writeBlock={null}
        stackBlock={stackBlock}
        stackHref="/projects/p1/board/stacks/1/design"
        busy={false}
        onPatch={async () => {}}
        onGenerate={async () => {}}
      />
    </UserProvider>,
  );

describe('GeneratePanel (#527)', () => {
  test("a stack card's Generate is disabled with the stack design's reason", () => {
    const html = render(`${STACK_GATE_REASON}: S-1 “Redesign”.`);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="design-stack-reason"/,
    );
    expect(html).toContain(STACK_GATE_REASON);
    expect(html).toContain('href="/projects/p1/board/stacks/1/design"');
  });

  test('without a stack block Generate is not held by the stack', () => {
    const html = render(null);
    expect(html).not.toContain('design-stack-reason');
    expect(html).not.toContain(STACK_GATE_REASON);
  });
});

describe('GeneratePanel (#606)', () => {
  test('a design not drawn yet does not claim the project has no UI profile', () => {
    // `profileId` is the design's, null until a revision is drawn; the
    // project's profile status is what says a build comes first.
    const html = render(null);
    expect(html).not.toContain('no UI profile yet');
  });
});
