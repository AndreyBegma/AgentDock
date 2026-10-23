import { Button } from '@andrewbehma/glass-ui/button';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { REVIEW_STEP_NAME_MAX } from '@nautelle/shared';
import { newStepRequest } from '../../lib/review/format';

/**
 * "Add step": a skill from the ones the project's runner reports, and a name.
 * Hook-free; the tab holds the draft and does the request.
 */
export function AddStepForm({
  name,
  skill,
  options,
  skillsError,
  busy,
  error,
  onName,
  onSkill,
  onAdd,
  onCancel,
}: {
  name: string;
  skill: string | null;
  options: { value: string; label: string }[];
  /** The skills could not be read; the picker is empty and says why. */
  skillsError: string | null;
  busy: boolean;
  /** The API's refusal (an unknown skill, too many steps), shown inline. */
  error: string | null;
  onName: (name: string) => void;
  onSkill: (skill: string | null) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const request = newStepRequest(name, skill);
  return (
    <form
      aria-label="Add a review step"
      className="flex flex-col gap-4 border-hairline border-t p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (request && !busy) onAdd();
      }}
    >
      <Field
        label="Skill"
        htmlFor="review-add-skill"
        hint="The skills your project’s runner reports. Rescan them under Skills if one is missing."
        error={skillsError ?? undefined}
      >
        <Combobox
          aria-label="Skill"
          placeholder="Search skills"
          options={options}
          value={skill}
          onValueChange={onSkill}
        />
      </Field>
      <Field
        label="Name"
        htmlFor="review-add-name"
        hint="How the step is called on a card."
      >
        <Input
          id="review-add-name"
          value={name}
          maxLength={REVIEW_STEP_NAME_MAX}
          onChange={(event) => onName(event.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="glass" type="submit" disabled={!request || busy}>
          Add step
        </Button>
      </div>
    </form>
  );
}
