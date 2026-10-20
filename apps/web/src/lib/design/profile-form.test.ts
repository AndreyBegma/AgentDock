import { describe, expect, test } from 'bun:test';
import {
  UI_PROFILE_KIT_MAX_BYTES,
  UI_PROFILE_SNIPPET_MAX_BYTES,
  type UiProfileVersionView,
} from '@nautelle/shared';
import { blankSnippet, readProfileForm, toForm } from './profile-form';

const profile: UiProfileVersionView = {
  id: 'p1',
  projectId: 'proj',
  version: 3,
  source: 'agent',
  hasUi: true,
  summary: '# UI\n\nTailwind 4, glass-ui.',
  kit: ':root { --accent: #0a84ff; }',
  snippets: [{ name: 'button', html: '<button class="btn">Go</button>' }],
  fingerprintGlobs: ['apps/web/**'],
  fingerprint: 'abc',
  obligations: null,
  runId: 'run-1',
  author: null,
  createdAt: '2026-10-14T10:00:00.000Z',
};

describe('readProfileForm', () => {
  test('round-trips a version into a manual one', () => {
    expect(readProfileForm(toForm(profile))).toEqual({
      ok: true,
      body: {
        hasUi: true,
        summary: profile.summary,
        kit: profile.kit,
        snippets: profile.snippets,
      },
    });
  });

  test('no profile yet: an empty form that asks for a summary', () => {
    const result = readProfileForm(toForm(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.summary).toMatch(/summary/);
  });

  test('a kit over its limit is refused beside the field', () => {
    const form = {
      ...toForm(profile),
      kit: 'x'.repeat(UI_PROFILE_KIT_MAX_BYTES + 1),
    };
    const result = readProfileForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.kit).toMatch(/KiB/);
  });

  test('names each bad snippet', () => {
    const form = toForm(profile);
    const empty = blankSnippet();
    const big = {
      ...blankSnippet(),
      name: 'table',
      html: 'x'.repeat(UI_PROFILE_SNIPPET_MAX_BYTES + 1),
    };
    const twin = { ...blankSnippet(), name: 'button', html: '<b>b</b>' };
    const result = readProfileForm({
      ...form,
      snippets: [...form.snippets, empty, big, twin],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.snippets[empty.key]).toMatch(/name/);
    expect(result.errors.snippets[big.key]).toMatch(/too large/);
    expect(result.errors.snippets[twin.key]).toMatch(/Another/);
  });
});
