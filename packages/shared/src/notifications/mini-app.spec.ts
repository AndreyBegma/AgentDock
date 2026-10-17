import { describe, expect, it } from 'bun:test';
import {
  miniAppPath,
  miniAppStartParam,
  miniAppTargetHref,
  miniAppTargetOfLink,
  parseMiniAppStartParam,
} from './mini-app';

const PROJECT = 'cmb1x2y3z0000abcd1234efgh';

describe('Mini App targets (#580)', () => {
  it('round-trips a Board and a card through start_param', () => {
    for (const target of [
      { projectId: PROJECT, card: null },
      { projectId: PROJECT, card: 213 },
    ]) {
      const param = miniAppStartParam(target);
      expect(param).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(parseMiniAppStartParam(param)).toEqual(target);
    }
  });

  it.each([
    [''],
    [null],
    ['_12'],
    [`${PROJECT}_0`],
    [`${PROJECT}_x`],
    [`${PROJECT}_1_2`],
    ['a/b'],
    ['x'.repeat(65)],
  ])('reads %p as no target', (raw) => {
    expect(parseMiniAppStartParam(raw)).toBeNull();
  });

  it('builds the entry path and the page a target opens', () => {
    expect(miniAppPath(null)).toBe('/tg');
    expect(miniAppPath({ projectId: PROJECT, card: 7 })).toBe(
      `/tg?start=${PROJECT}_7`,
    );
    expect(miniAppTargetHref({ projectId: PROJECT, card: null })).toBe(
      `/projects/${PROJECT}/board`,
    );
    expect(miniAppTargetHref({ projectId: PROJECT, card: 7 })).toBe(
      `/projects/${PROJECT}/board?card=7`,
    );
  });

  it('reads a card out of a card link, and nothing out of others', () => {
    expect(miniAppTargetOfLink(`/projects/${PROJECT}/board?card=42`)).toEqual({
      projectId: PROJECT,
      card: 42,
    });
    for (const link of [
      null,
      `/projects/${PROJECT}/board`,
      `/projects/${PROJECT}/approvals`,
      `/projects/${PROJECT}/board?card=42&x=1`,
      '/admin/runners',
    ]) {
      expect(miniAppTargetOfLink(link)).toBeNull();
    }
  });
});
