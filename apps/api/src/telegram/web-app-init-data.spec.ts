import { initDataHash, verifyInitData } from './web-app-init-data';

const TOKEN = '123456:ABCdefGhIJKlmnOPQRstuVWXyz0123456789';
const AUTH_DATE = 1_760_000_000;
const USER = '{"id":4242,"first_name":"Ada","username":"ada_tg"}';
/** Computed outside this code (Python's `hmac`), per Telegram's Web App rules. */
const KNOWN_HASH =
  '76a424de3437b14074a0bc4a5ea42ea90040142af660ae652e296b3d21321cce';
const at = (seconds: number) => new Date(seconds * 1000);

const fields = (overrides: Record<string, string> = {}) => ({
  auth_date: String(AUTH_DATE),
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  user: USER,
  start_param: 'p1',
  ...overrides,
});

/** `initData` as Telegram sends it: URL-encoded, signed with `token`. */
const signed = (values: Record<string, string>, token = TOKEN): string => {
  const params = new URLSearchParams(values);
  params.set('hash', initDataHash(Object.entries(values), token));
  return params.toString();
};

describe('verifyInitData', () => {
  it('matches a hash computed independently of this code', () => {
    expect(initDataHash(Object.entries(fields()), TOKEN)).toBe(KNOWN_HASH);
    const initData = new URLSearchParams({
      ...fields(),
      hash: KNOWN_HASH,
    }).toString();
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE + 10))).toEqual({
      ok: true,
      init: {
        userId: 4242,
        username: 'ada_tg',
        authDate: at(AUTH_DATE),
        startParam: 'p1',
      },
    });
  });

  it('accepts the fields in any order', () => {
    const params = new URLSearchParams(signed(fields()));
    const reversed = new URLSearchParams([...params.entries()].reverse());
    expect(verifyInitData(reversed.toString(), TOKEN, at(AUTH_DATE)).ok).toBe(
      true,
    );
  });

  it('refuses a changed field', () => {
    const params = new URLSearchParams(signed(fields()));
    params.set('user', '{"id":1,"first_name":"Eve"}');
    expect(verifyInitData(params.toString(), TOKEN, at(AUTH_DATE))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an added field', () => {
    const initData = `${signed(fields())}&chat_type=private`;
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE)).ok).toBe(false);
  });

  it('refuses a field sent twice, even when one copy is signed', () => {
    const initData = `${signed(fields())}&user=${encodeURIComponent(USER)}`;
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE)).ok).toBe(false);
  });

  it('refuses data signed with another bot token', () => {
    const initData = signed(
      fields(),
      '654321:ZYXwvuTSRqpoNMLkjiHGFedcba9876543210',
    );
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it.each([
    ['no hash', new URLSearchParams(fields()).toString()],
    ['a malformed hash', `${new URLSearchParams(fields())}&hash=zz`],
    ['nothing', ''],
    ['too much', `${signed(fields())}&pad=${'x'.repeat(5000)}`],
  ])('refuses %s', (_label, initData) => {
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE)).ok).toBe(false);
  });

  it('refuses signed data without a user, or with a malformed one', () => {
    const { user: _user, ...rest } = fields();
    expect(verifyInitData(signed(rest), TOKEN, at(AUTH_DATE)).ok).toBe(false);
    for (const user of ['not json', '{"id":"42"}', '{"id":-1}', 'null']) {
      expect(
        verifyInitData(signed(fields({ user })), TOKEN, at(AUTH_DATE)).ok,
      ).toBe(false);
    }
  });

  it('reports expired data older than the limit, and takes it up to it', () => {
    const initData = signed(fields());
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE + 3600)).ok).toBe(true);
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE + 3601))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyInitData(initData, TOKEN, at(AUTH_DATE + 120), 60)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses an auth_date from the future, or none', () => {
    expect(
      verifyInitData(signed(fields()), TOKEN, at(AUTH_DATE - 3600)),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      verifyInitData(
        signed(fields({ auth_date: 'soon' })),
        TOKEN,
        at(AUTH_DATE),
      ).ok,
    ).toBe(false);
  });

  it('reads no start parameter as null', () => {
    const { start_param: _sp, ...rest } = fields();
    const check = verifyInitData(signed(rest), TOKEN, at(AUTH_DATE));
    expect(check.ok && check.init.startParam).toBeNull();
  });
});
