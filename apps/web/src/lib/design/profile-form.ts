import {
  designBytes,
  UI_PROFILE_KIT_MAX_BYTES,
  UI_PROFILE_SNIPPETS_MAX,
  UI_PROFILE_SUMMARY_MAX,
  type UiProfileUpdateRequest,
  type UiProfileVersionView,
  uiProfileSnippetSchema,
} from '@agentdock/shared';

/**
 * The profile editor (spec 223 D14, Settings → Design): a manual version is
 * the whole summary, kit and snippet list. `readProfileForm` checks it
 * against the same limits the API holds, so a refusal is said beside the
 * field rather than in a toast.
 */
export interface ProfileForm {
  hasUi: boolean;
  summary: string;
  kit: string;
  snippets: { key: string; name: string; html: string }[];
}

let seq = 0;
const key = (): string => {
  seq += 1;
  return `snippet-${seq}`;
};

export const toForm = (profile: UiProfileVersionView | null): ProfileForm => ({
  hasUi: profile?.hasUi ?? true,
  summary: profile?.summary ?? '',
  kit: profile?.kit ?? '',
  snippets: (profile?.snippets ?? []).map((s) => ({ key: key(), ...s })),
});

export const blankSnippet = (): ProfileForm['snippets'][number] => ({
  key: key(),
  name: '',
  html: '',
});

export const canAddSnippet = (form: ProfileForm): boolean =>
  form.snippets.length < UI_PROFILE_SNIPPETS_MAX;

export type ProfileFormErrors = {
  summary?: string;
  kit?: string;
  /** By snippet key. */
  snippets: Record<string, string>;
};

export type ProfileFormResult =
  | { ok: true; body: UiProfileUpdateRequest }
  | { ok: false; errors: ProfileFormErrors };

export function readProfileForm(form: ProfileForm): ProfileFormResult {
  const errors: ProfileFormErrors = { snippets: {} };
  if (!form.summary.trim()) errors.summary = 'Describe the UI in the summary.';
  else if (form.summary.length > UI_PROFILE_SUMMARY_MAX) {
    errors.summary = `At most ${UI_PROFILE_SUMMARY_MAX.toLocaleString('en')} characters.`;
  }
  if (designBytes(form.kit) > UI_PROFILE_KIT_MAX_BYTES) {
    errors.kit = `At most ${UI_PROFILE_KIT_MAX_BYTES / 1024} KiB: every mockup carries the kit.`;
  }

  const names = new Set<string>();
  const snippets: UiProfileUpdateRequest['snippets'] = [];
  for (const row of form.snippets) {
    const parsed = uiProfileSnippetSchema.safeParse({
      name: row.name.trim(),
      html: row.html,
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      errors.snippets[row.key] =
        field === 'html'
          ? row.html
            ? 'The HTML is too large for one snippet.'
            : 'Give the snippet its HTML.'
          : 'Give the snippet a name.';
      continue;
    }
    if (names.has(parsed.data.name)) {
      errors.snippets[row.key] = 'Another snippet has this name.';
      continue;
    }
    names.add(parsed.data.name);
    snippets.push(parsed.data);
  }

  if (errors.summary || errors.kit || Object.keys(errors.snippets).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      hasUi: form.hasUi,
      summary: form.summary.trim(),
      kit: form.kit,
      snippets,
    },
  };
}
