import type { AuthUser } from '../auth';
import { cookieFrom, originAllowed } from './handshake';
import { TopicAuthorizerRegistry } from './topic-authorizer.registry';

const user = (id: string, role: AuthUser['role']): AuthUser => ({
  id,
  email: `${id}@example.com`,
  name: null,
  role,
  status: 'active',
});

describe('cookieFrom', () => {
  it('finds the cookie among others', () => {
    expect(cookieFrom('a=1; ad_session=tok; ad_csrf=x', 'ad_session')).toBe(
      'tok',
    );
  });

  it('does not match a cookie whose name only ends with the name', () => {
    expect(cookieFrom('xad_session=evil', 'ad_session')).toBeNull();
  });

  it('decodes and unquotes the value', () => {
    expect(cookieFrom('ad_session="a%2Bb"', 'ad_session')).toBe('a+b');
  });

  it.each([
    undefined,
    '',
    'ad_session=',
    'other=1',
    'ad_session=%E0%A4%A',
  ])('is null for %p', (header) => {
    expect(cookieFrom(header, 'ad_session')).toBeNull();
  });
});

describe('originAllowed', () => {
  const web = 'http://localhost:3517';

  it('accepts the exact origin', () => {
    expect(originAllowed('http://localhost:3517', web)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'null',
    'http://localhost:3518',
    'https://localhost:3517',
    'http://evil.example',
    'http://localhost:3517.evil.example',
  ])('refuses %p', (origin) => {
    expect(originAllowed(origin, web)).toBe(false);
  });
});

describe('TopicAuthorizerRegistry', () => {
  const registry = new TopicAuthorizerRegistry();
  const admin = user('a1', 'admin');
  const viewer = user('v1', 'viewer');

  it('admin and runner topics are admin-only', async () => {
    for (const topic of ['admin', 'runner:r1']) {
      expect(await registry.decide(admin, topic)).toBe('allowed');
      expect(await registry.decide(viewer, topic)).toBe('forbidden');
      expect(await registry.decide(user('o1', 'operator'), topic)).toBe(
        'forbidden',
      );
    }
  });

  it('a user topic is its owner’s only, admins included', async () => {
    expect(await registry.decide(viewer, 'user:v1')).toBe('allowed');
    expect(await registry.decide(viewer, 'user:a1')).toBe('forbidden');
    expect(await registry.decide(admin, 'user:v1')).toBe('forbidden');
  });

  it('project topics are unknown until an authorizer is registered', async () => {
    expect(await registry.decide(admin, 'project:p1')).toBe('unknown_topic');
    const withProjects = new TopicAuthorizerRegistry();
    withProjects.register('project', async (_user, id) => id === 'p1');
    expect(await withProjects.decide(viewer, 'project:p1')).toBe('allowed');
    expect(await withProjects.decide(viewer, 'project:p2')).toBe('forbidden');
  });

  it('passes an authorizer’s not_found through', async () => {
    const withPanes = new TopicAuthorizerRegistry();
    withPanes.register('pane', (_user, id) =>
      id === 'p1:i42' ? true : 'not_found',
    );
    expect(await withPanes.decide(viewer, 'pane:p1:i42')).toBe('allowed');
    expect(await withPanes.decide(viewer, 'pane:p1:b7')).toBe('not_found');
  });

  it('refuses a second authorizer for the same prefix', () => {
    expect(() => registry.register('user', () => true)).toThrow(
      /already has an authorizer/,
    );
  });
});
