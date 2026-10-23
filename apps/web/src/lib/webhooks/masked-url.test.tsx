import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { maskUrlPath } from './format';
import { MaskedUrl, MaskedUrlView } from './masked-url';

const URL = 'https://hooks.example.test/hooks/tr_s3cretpath?token=abc';

describe('maskUrlPath (C-177)', () => {
  test('keeps the scheme and host, hides the path, query and credentials', () => {
    expect(maskUrlPath(URL)).toBe('https://hooks.example.test/••••••••');
    expect(maskUrlPath('https://user:pw@x.test:8443/a')).toBe(
      'https://x.test:8443/••••••••',
    );
  });

  test('hides a URL that does not parse whole', () => {
    expect(maskUrlPath('not a url /secret')).toBe('••••••••');
  });
});

describe('MaskedUrl (C-177)', () => {
  test('starts masked, with Reveal and no copy of the mask', () => {
    const html = renderToStaticMarkup(<MaskedUrl url={URL} />);
    expect(html).not.toContain('tr_s3cretpath');
    expect(html).not.toContain('token=abc');
    expect(html).toContain('https://hooks.example.test/••••••••');
    expect(html).toContain('Reveal');
    expect(html).not.toContain('Copy');
  });

  test('shows the whole URL once Reveal is pressed', () => {
    const html = renderToStaticMarkup(
      <MaskedUrlView url={URL} revealed onRevealedChange={() => {}} />,
    );
    expect(html).toContain('tr_s3cretpath?token=abc');
    expect(html).toContain('Hide');
  });

  test('Reveal asks to reveal, Hide asks to hide', () => {
    const asked: boolean[] = [];
    const press = (revealed: boolean) => {
      const view = MaskedUrlView({
        url: URL,
        revealed,
        onRevealedChange: (next) => asked.push(next),
      });
      const button = view.props.children[1];
      button.props.onClick();
    };
    press(false);
    press(true);
    expect(asked).toEqual([true, false]);
  });
});
