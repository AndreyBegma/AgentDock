'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import type { UiProfileVersionView } from '@nautelle/shared';
import { useId, useState } from 'react';
import { api } from '../../../../../../lib/api';
import { describeDesignError } from '../../../../../../lib/design/format';
import { uiProfileApi } from '../../../../../../lib/design/href';
import {
  blankSnippet,
  canAddSnippet,
  type ProfileForm,
  type ProfileFormErrors,
  readProfileForm,
  toForm,
} from '../../../../../../lib/design/profile-form';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';

const MONO = 'font-mono text-xs leading-relaxed';

/**
 * A person's fix to the profile (spec 223 D14): the whole summary, kit and
 * snippet list, saved as a new `manual` version. The next rebuild receives
 * the difference as rules it must keep.
 */
export function ProfileEditor({
  projectId,
  profile,
  onDone,
}: {
  projectId: string;
  profile: UiProfileVersionView;
  onDone: (saved: boolean) => void;
}) {
  const [form, setForm] = useState<ProfileForm>(() => toForm(profile));
  const [errors, setErrors] = useState<ProfileFormErrors>({ snippets: {} });
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const hasUiId = useId();

  const set = (patch: Partial<ProfileForm>) =>
    setForm((f) => ({ ...f, ...patch }));
  const setSnippet = (
    key: string,
    patch: Partial<ProfileForm['snippets'][number]>,
  ) =>
    set({
      snippets: form.snippets.map((s) =>
        s.key === key ? { ...s, ...patch } : s,
      ),
    });

  const save = async () => {
    const result = readProfileForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({ snippets: {} });
    setBusy(true);
    try {
      await api(uiProfileApi(projectId), { method: 'PUT', body: result.body });
      toast.success('Profile saved as a new version');
      onDone(true);
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="max-w-prose text-sm text-ink-2">
        Saving writes version {profile.version + 1}. A rebuild keeps your
        changes as rules it must follow.
      </p>

      <div className="flex items-center gap-3">
        <Toggle
          checked={form.hasUi}
          labelledBy={hasUiId}
          onChange={(hasUi) => set({ hasUi })}
        />
        <span id={hasUiId} className="text-sm">
          The project has a user interface
        </span>
      </div>

      <Field label="Summary (Markdown)" error={errors.summary}>
        <Textarea
          className={MONO}
          rows={14}
          value={form.summary}
          onChange={(e) => set({ summary: e.target.value })}
        />
      </Field>

      <Field
        label="Style kit (CSS)"
        hint="Custom properties for the tokens, base typography, the key components."
        error={errors.kit}
      >
        <Textarea
          className={MONO}
          rows={14}
          spellCheck={false}
          value={form.kit}
          onChange={(e) => set({ kit: e.target.value })}
        />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">Snippets</legend>
        {form.snippets.map((s, i) => (
          <div
            key={s.key}
            className="flex flex-col gap-2 rounded-md border border-line p-3"
          >
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field
                  label={`Snippet ${i + 1} name`}
                  error={errors.snippets[s.key]}
                >
                  <Input
                    value={s.name}
                    placeholder="button"
                    onChange={(e) =>
                      setSnippet(s.key, { name: e.target.value })
                    }
                  />
                </Field>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  set({
                    snippets: form.snippets.filter((x) => x.key !== s.key),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <Textarea
              aria-label={`Snippet ${i + 1} HTML`}
              className={MONO}
              rows={5}
              spellCheck={false}
              value={s.html}
              onChange={(e) => setSnippet(s.key, { html: e.target.value })}
            />
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="glass"
          className="self-start"
          disabled={!canAddSnippet(form)}
          onClick={() => set({ snippets: [...form.snippets, blankSnippet()] })}
        >
          Add snippet
        </Button>
      </fieldset>

      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="solid" disabled={busy}>
          {busy ? 'Saving…' : 'Save new version'}
        </Button>
      </div>
    </form>
  );
}
