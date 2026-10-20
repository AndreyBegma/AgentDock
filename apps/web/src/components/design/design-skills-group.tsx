'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { DESIGN_SKILLS_MAX, type DesignOwnerKind } from '@nautelle/shared';
import { Info, Save, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import {
  isDefaultSet,
  type SkillsForm,
  skillsDiff,
  skillsSource,
} from '../../lib/design/skills';

/** A diff shows this many skills, then "+N more". */
const DIFF_SHOWN = 3;

const SOURCE_LABEL = {
  default: 'Project default',
  edited: (noun: string) => `Edited for this ${noun}`,
  none: 'No default',
} as const;

const diffText = (form: SkillsForm, defaults: readonly string[]): string => {
  const { added, removed } = skillsDiff(form.skills, defaults);
  const parts = [...added.map((s) => `+${s}`), ...removed.map((s) => `−${s}`)];
  if (parts.length === 0) return 'Same as the default.';
  const more = parts.length - DIFF_SHOWN;
  return `Differs from the default: ${parts.slice(0, DIFF_SHOWN).join(', ')}${
    more > 0 ? ` +${more} more` : ''
  }.`;
};

/**
 * #604: the design skills of the Generate panel — where the set comes from
 * (the project default, or a hand edit that a change of the default no
 * longer reaches), **Use defaults**, the skills no longer installed, and for
 * a project admin **Save as project default**.
 */
export function DesignSkillsGroup({
  owner,
  form,
  defaults,
  options,
  missing,
  listError,
  isAdmin,
  disabled,
  saving,
  settingsHref,
  onChange,
  onUseDefaults,
  onSaveDefault,
}: {
  owner: DesignOwnerKind;
  form: SkillsForm;
  /** The project default (Settings → Design). */
  defaults: readonly string[];
  options: { value: string; label: string }[];
  /** Chosen skills not installed for the project: turns skip them. */
  missing: readonly string[];
  /** The installed skills could not be listed. */
  listError: boolean;
  isAdmin: boolean;
  disabled: boolean;
  saving: boolean;
  settingsHref: string;
  onChange: (skills: string[]) => void;
  onUseDefaults: () => void;
  onSaveDefault: () => void;
}) {
  const source = skillsSource(form, defaults);
  const count = `${form.skills.length} of ${DESIGN_SKILLS_MAX}.`;
  const hint = listError
    ? 'The installed skills could not be listed; the chosen ones are kept.'
    : source === 'edited'
      ? `${count} ${diffText(form, defaults)} A change to the default no longer reaches this ${owner}.`
      : source === 'default'
        ? `${count} A change to the project default reaches this ${owner} until you edit the set here.`
        : `Up to ${DESIGN_SKILLS_MAX}. Skills are optional.`;
  const saved = isDefaultSet(form.skills, defaults);

  return (
    <fieldset
      aria-labelledby="design-skills"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-line p-3"
    >
      <div className="flex items-center gap-2">
        <span id="design-skills" className="text-sm font-medium">
          Design skills
        </span>
        <Badge
          size="md"
          tone={source === 'default' ? 'ok' : 'neutral'}
          label={
            source === 'edited'
              ? SOURCE_LABEL.edited(owner)
              : SOURCE_LABEL[source]
          }
          title={
            source === 'edited'
              ? `This ${owner} keeps its own set`
              : source === 'default'
                ? 'Follows Settings → Design until edited here'
                : undefined
          }
        />
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="ml-auto max-lg:h-11"
          disabled={!form.edited || disabled}
          onClick={onUseDefaults}
        >
          Use defaults
        </Button>
      </div>
      <Combobox
        multiple
        aria-label="Design skills"
        options={options}
        value={form.skills}
        disabled={disabled}
        placeholder="Add a skill"
        onValueChange={(next) => onChange(next.slice(0, DESIGN_SKILLS_MAX))}
      />
      {missing.length > 0 ? (
        <p role="status" className="flex items-start gap-1.5 text-xs text-warn">
          <TriangleAlert
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0"
          />
          <span>
            {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not
            installed and {missing.length === 1 ? 'is' : 'are'} skipped.
          </span>
        </p>
      ) : null}
      <p className="text-xs text-ink-2">{hint}</p>
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <p className="min-w-0 flex-1 text-xs text-ink-2">
            <span className="font-medium text-ink">Project default</span> ·{' '}
            {saved
              ? 'this is the saved set.'
              : 'applies to every design not yet generated that follows the default. Audited.'}
          </p>
          <Button
            variant="glass"
            size="sm"
            type="button"
            className="max-lg:h-11"
            disabled={saved || disabled || saving}
            onClick={onSaveDefault}
          >
            <Save aria-hidden="true" className="size-3.5" />
            {saving ? 'Saving…' : 'Save as project default'}
          </Button>
        </div>
      ) : defaults.length === 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-ink-2">
          <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            This project has no default skill set. A project admin can save one
            here or in{' '}
            <Link href={settingsHref} className="text-accent underline">
              Settings → Design
            </Link>
            , and every {owner} follows it.
          </span>
        </p>
      ) : null}
    </fieldset>
  );
}
