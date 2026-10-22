import {
  builtinDesignTemplate,
  builtinOverrideProblems,
  DESIGN_TEMPLATE_KEY_MAX,
  type DesignTemplateFrame,
  type DesignTemplateUpsertRequest,
  type DesignTemplateView,
  designTemplateSchema,
} from '@nautelle/shared';

/**
 * The templates editor (#833 D9, Settings → Design → Templates). A draft is
 * one template as the form holds it; the server's rules are checked again
 * here so a refusal reads next to the field, not as a bare 400.
 */
export interface TemplateDraft {
  key: string;
  name: string;
  frames: DesignTemplateFrame[];
}

export const draftOf = (view: DesignTemplateView): TemplateDraft => ({
  key: view.key,
  name: view.name,
  frames: view.frames.map((f) => ({
    ...f,
    ...(f.repeat ? { repeat: { ...f.repeat } } : {}),
  })),
});

/** A frame the built-in template of `templateKey` defines. */
export const isBuiltinFrame = (templateKey: string, frameKey: string) =>
  builtinDesignTemplate(templateKey)?.frames.some((f) => f.key === frameKey) ===
  true;

export const moveFrame = (
  frames: readonly DesignTemplateFrame[],
  index: number,
  by: -1 | 1,
): DesignTemplateFrame[] => {
  const to = index + by;
  if (to < 0 || to >= frames.length) return [...frames];
  const next = [...frames];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
};

export const patchFrame = (
  frames: readonly DesignTemplateFrame[],
  key: string,
  patch: Partial<DesignTemplateFrame>,
): DesignTemplateFrame[] =>
  frames.map((f) => (f.key === key ? { ...f, ...patch } : f));

/** A new custom frame with a key no frame of the template has. */
export const addCustomFrame = (
  frames: readonly DesignTemplateFrame[],
): DesignTemplateFrame[] => {
  const taken = new Set(frames.map((f) => f.key));
  let n = 1;
  while (taken.has(`custom-${n}`)) n += 1;
  return [
    ...frames,
    {
      key: `custom-${n}`,
      kind: 'custom',
      name: '',
      instruction: '',
      required: false,
      enabled: true,
    },
  ];
};

/** Only a custom frame can be removed; a built-in one is disabled instead. */
export const removeFrame = (
  templateKey: string,
  frames: readonly DesignTemplateFrame[],
  key: string,
): DesignTemplateFrame[] =>
  isBuiltinFrame(templateKey, key)
    ? [...frames]
    : frames.filter((f) => f.key !== key);

/** A key for a new template named `name`; empty when nothing usable is left. */
export const templateKeyOf = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, DESIGN_TEMPLATE_KEY_MAX)
    .replace(/-+$/, '');
  return slug;
};

/** A blank template: the one frame every design needs, to be filled in. */
export const blankDraft = (name: string): TemplateDraft => ({
  key: templateKeyOf(name),
  name: name.trim(),
  frames: [
    {
      key: 'screen',
      kind: 'screen',
      name: 'Screen',
      instruction: '',
      required: true,
      enabled: true,
    },
  ],
});

export const requestOf = (
  draft: TemplateDraft,
): DesignTemplateUpsertRequest => ({
  name: draft.name.trim(),
  frames: draft.frames.map((f) => ({
    ...f,
    name: f.name.trim(),
    instruction: f.instruction.trim(),
  })),
});

/** What is wrong with the draft, in plain words; empty when it can be saved. */
export const draftProblems = (draft: TemplateDraft): string[] => {
  const request = requestOf(draft);
  const checked = designTemplateSchema.safeParse({
    key: draft.key,
    ...request,
  });
  if (!checked.success) {
    return checked.error.issues.map((issue) => {
      const [, index, field] = issue.path;
      const where =
        typeof index === 'number'
          ? `Frame ${index + 1}${typeof field === 'string' ? ` ${field}` : ''}`
          : issue.path.length > 0
            ? String(issue.path[0])
            : 'Template';
      return `${where}: ${issue.message}`;
    });
  }
  const builtin = builtinDesignTemplate(draft.key);
  return builtin ? builtinOverrideProblems(builtin, checked.data) : [];
};
