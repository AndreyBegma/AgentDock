import { describe, expect, test } from 'bun:test';
import { parseUserAgent } from './user-agent';

const label = (ua: string | null) => parseUserAgent(ua).label;

describe('parseUserAgent', () => {
  test('desktop browsers by major version and system', () => {
    expect(
      label(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 155 on macOS');
    expect(
      label(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
      ),
    ).toBe('Safari 18 on macOS');
    expect(
      label(
        'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
      ),
    ).toBe('Firefox 140 on Linux');
    expect(
      label(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.3000.1',
      ),
    ).toBe('Edge 150 on Windows');
  });

  test('phones are mobile', () => {
    const iphone = parseUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
    );
    expect(iphone).toEqual({ label: 'Safari 18 on iOS', mobile: true });
    const android = parseUserAgent(
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
    );
    expect(android).toEqual({ label: 'Chrome 155 on Android', mobile: true });
  });

  test('tools, unknown agents and nothing', () => {
    expect(label('curl/8.9.1')).toBe('curl 8');
    expect(label('SomeBot/1.0 (Linux)')).toBe('Unknown browser on Linux');
    expect(label('???')).toBe('Unknown device');
    expect(label(null)).toBe('Unknown device');
    expect(label('  ')).toBe('Unknown device');
  });
});
