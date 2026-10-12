import { createHmac } from 'node:crypto';
import { signGitHubDelivery, verifyGitHubSignature } from './github-signature';

const SECRET = 'whsec-of-the-app';
const BODY = Buffer.from('{"action":"labeled","issue":{"number":7}}');

describe('GitHub delivery signatures (spec 27 D6)', () => {
  it('signs as GitHub does: sha256= HMAC-SHA256(secret, raw body) in hex', () => {
    const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(signGitHubDelivery(SECRET, BODY)).toBe(`sha256=${hex}`);
  });

  it('accepts a delivery signed with the secret, in either hex case', () => {
    const header = signGitHubDelivery(SECRET, BODY);
    expect(verifyGitHubSignature(header, BODY, SECRET)).toBe(true);
    expect(
      verifyGitHubSignature(
        `sha256=${header.slice(7).toUpperCase()}`,
        BODY,
        SECRET,
      ),
    ).toBe(true);
  });

  it('refuses a wrong secret, a modified body, a missing or malformed header', () => {
    const header = signGitHubDelivery(SECRET, BODY);
    expect(verifyGitHubSignature(header, BODY, 'other')).toBe(false);
    expect(
      verifyGitHubSignature(header, Buffer.from(`${BODY.toString()} `), SECRET),
    ).toBe(false);
    expect(verifyGitHubSignature(undefined, BODY, SECRET)).toBe(false);
    expect(verifyGitHubSignature('', BODY, SECRET)).toBe(false);
    expect(verifyGitHubSignature(header.slice(7), BODY, SECRET)).toBe(false);
    expect(
      verifyGitHubSignature(header.replace('sha256', 'sha1'), BODY, SECRET),
    ).toBe(false);
    expect(verifyGitHubSignature(`${header}00`, BODY, SECRET)).toBe(false);
  });
});
