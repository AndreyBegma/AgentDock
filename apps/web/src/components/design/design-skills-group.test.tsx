import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkillsForm } from '../../lib/design/skills';
import { DesignSkillsGroup } from './design-skills-group';

const DEFAULTS = ['web-design-guidelines', 'frontend-design'];

const render = ({
  form = { skills: DEFAULTS, edited: false },
  defaults = DEFAULTS,
  isAdmin = false,
  missing = [],
}: {
  form?: SkillsForm;
  defaults?: string[];
  isAdmin?: boolean;
  missing?: string[];
}) =>
  renderToStaticMarkup(
    <DesignSkillsGroup
      owner="card"
      form={form}
      defaults={defaults}
      options={form.skills.map((s) => ({ value: s, label: s }))}
      missing={missing}
      listError={false}
      isAdmin={isAdmin}
      disabled={false}
      saving={false}
      settingsHref="/projects/p1/settings?tab=design"
      onChange={() => {}}
      onUseDefaults={() => {}}
      onSaveDefault={() => {}}
    />,
  );

const useDefaults = (html: string) =>
  html.match(/<button[^>]*>Use defaults<\/button>/)?.[0] ?? '';

describe('DesignSkillsGroup (#604)', () => {
  test('following the default: tagged, Use defaults off, nothing to save', () => {
    const html = render({ isAdmin: true });
    expect(html).toContain('Project default');
    expect(html).toContain('reaches this card until you edit the set here');
    expect(useDefaults(html)).toContain('disabled=""');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>.*Save as project default<\/button>/,
    );
    expect(html).toContain('this is the saved set.');
  });

  test('edited by an admin: tagged, with the diff, Use defaults and an audited save', () => {
    const html = render({
      isAdmin: true,
      form: { skills: ['frontend-design', 'ui-ux'], edited: true },
      missing: ['ui-ux'],
    });
    expect(html).toContain('Edited for this card');
    expect(html).toContain('+ui-ux, −web-design-guidelines');
    expect(html).toContain('no longer reaches this card');
    expect(useDefaults(html)).not.toContain('disabled=""');
    expect(html).toContain('ui-ux is not installed and is skipped.');
    expect(html).toMatch(/Audited\./);
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>.*Save as project default<\/button>/,
    );
  });

  test('a non-admin sees no Save as project default; an empty default points to Settings → Design', () => {
    const edited = render({ form: { skills: ['x'], edited: true } });
    expect(edited).not.toContain('Save as project default');
    const empty = render({ form: { skills: [], edited: false }, defaults: [] });
    expect(empty).not.toContain('Save as project default');
    expect(empty).toContain('No default');
    expect(empty).toContain('This project has no default skill set.');
    expect(empty).toContain('href="/projects/p1/settings?tab=design"');
  });
});
