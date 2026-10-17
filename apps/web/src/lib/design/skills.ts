import type { TaskDesignPatchRequest, TaskDesignView } from '@agentdock/shared';

/**
 * #604: the panel's skills — a design follows the project default until its
 * set is edited by hand; **Use defaults** returns it to following.
 */
export interface SkillsForm {
  skills: string[];
  edited: boolean;
}

/** Where the panel's set comes from, for the group's tag. */
export type SkillsSource = 'default' | 'edited' | 'none';

export const skillsFormOf = (
  design: Pick<TaskDesignView, 'skills' | 'skillsEdited'>,
): SkillsForm => ({ skills: design.skills, edited: design.skillsEdited });

export const skillsSource = (
  form: SkillsForm,
  defaults: readonly string[],
): SkillsSource =>
  form.edited ? 'edited' : defaults.length > 0 ? 'default' : 'none';

const sameSkills = (a: readonly string[], b: readonly string[]): boolean =>
  a.join('\n') === b.join('\n');

/**
 * What Generate patches for the skills: a hand edit only when the set was
 * edited here — sending `skills` keeps them on the design — and a return to
 * the default when **Use defaults** dropped a stored edit.
 */
export const skillsPatch = (
  form: SkillsForm,
  design: Pick<TaskDesignView, 'skills' | 'skillsEdited'>,
): Pick<TaskDesignPatchRequest, 'skills' | 'useDefaultSkills'> => {
  if (form.edited) {
    return design.skillsEdited && sameSkills(form.skills, design.skills)
      ? {}
      : { skills: form.skills };
  }
  return design.skillsEdited ? { useDefaultSkills: true } : {};
};

/** Whether the set is the project default already (nothing to save). */
export const isDefaultSet = (
  skills: readonly string[],
  defaults: readonly string[],
): boolean =>
  skills.length === defaults.length &&
  skills.every((s) => defaults.includes(s));

/** The skills added to and dropped from the default, in the panel's order. */
export const skillsDiff = (
  skills: readonly string[],
  defaults: readonly string[],
): { added: string[]; removed: string[] } => ({
  added: skills.filter((s) => !defaults.includes(s)),
  removed: defaults.filter((s) => !skills.includes(s)),
});
