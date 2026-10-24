'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  DEMO_SECRET_NAME_MAX,
  DEMO_SECRET_NAME_PATTERN,
  DEMO_SECRET_VALUE_MAX,
  type DemoSecretView,
} from '@nautelle/shared';
import { type FormEvent, useState } from 'react';
import {
  deleteDemoSecret,
  fetchDemoSecrets,
  putDemoSecret,
} from '../../lib/demos/actions';
import { describeDemoError } from '../../lib/demos/format';
import { Time } from '../../lib/format/time';
import { useErrorToast } from '../../lib/section/use-error-toast';

/**
 * The secrets as the page shows them: names, who changed them and when —
 * never a value, which the API does not return. Pure, so a test can render it.
 */
export function DemoSecretsList({
  secrets,
  isAdmin,
  busy = false,
  onReplace,
  onDelete,
}: {
  secrets: readonly DemoSecretView[];
  isAdmin: boolean;
  busy?: boolean;
  onReplace?: (name: string) => void;
  onDelete?: (name: string) => void;
}) {
  if (secrets.length === 0) {
    return (
      <p className="text-ink-3 text-sm">
        No demo secrets. A scenario that signs in needs one for each value it
        reads from the environment.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line">
      {secrets.map((secret) => (
        <li
          key={secret.name}
          className="flex flex-wrap items-center justify-between gap-2 py-2"
        >
          <span className="flex min-w-0 flex-1 basis-56 flex-col">
            <code className="break-all text-sm">{secret.name}</code>
            <span className="text-ink-3 text-xs">
              Value hidden · set <Time value={secret.updatedAt} />
              {secret.updatedByName ? ` by ${secret.updatedByName}` : ''}
            </span>
          </span>
          {isAdmin ? (
            <span className="flex shrink-0 gap-2">
              <Button
                variant="glass"
                disabled={busy}
                onClick={() => onReplace?.(secret.name)}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onDelete?.(secret.name)}
              >
                Delete
              </Button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The write-only form: a name and a value, sent once. The value lives in this
 * input only until the answer comes back, then the field is emptied; it is a
 * password input, so it is masked on screen and not offered for autofill.
 */
export function DemoSecretForm({
  name,
  value,
  busy,
  replacing,
  onNameChange,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  name: string;
  value: string;
  busy: boolean;
  /** The name is fixed: this replaces a secret that exists. */
  replacing: boolean;
  onNameChange: (name: string) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const nameError =
    name !== '' && !DEMO_SECRET_NAME_PATTERN.test(name)
      ? 'Use an environment variable name: capitals, digits and underscores, not starting with a digit.'
      : undefined;
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <Field
        label="Name"
        htmlFor="demo-secret-name"
        hint="The name the scenario reads with valueFrom.env."
        error={nameError}
      >
        <Input
          id="demo-secret-name"
          value={name}
          maxLength={DEMO_SECRET_NAME_MAX}
          readOnly={replacing}
          autoComplete="off"
          spellCheck={false}
          placeholder="DEMO_ADMIN_PASSWORD"
          onChange={(e) => onNameChange(e.target.value)}
        />
      </Field>
      <Field
        label={replacing ? 'New value' : 'Value'}
        htmlFor="demo-secret-value"
        hint="Write-only: it is stored encrypted and cannot be shown again."
      >
        <Input
          id="demo-secret-value"
          type="password"
          value={value}
          maxLength={DEMO_SECRET_VALUE_MAX}
          autoComplete="new-password"
          onChange={(e) => onValueChange(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        {replacing ? (
          <Button variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="solid"
          type="submit"
          disabled={
            busy || name === '' || value === '' || nameError !== undefined
          }
        >
          {replacing ? 'Replace' : 'Add secret'}
        </Button>
      </div>
    </form>
  );
}

/** The Demo env secrets editor of Settings → Demo videos (admin writes). */
export function DemoSecretsEditor({
  projectId,
  isAdmin,
  secrets,
  onChanged,
}: {
  projectId: string;
  isAdmin: boolean;
  secrets: readonly DemoSecretView[];
  onChanged: (secrets: DemoSecretView[]) => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const reset = () => {
    setName('');
    setValue('');
    setReplacing(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await putDemoSecret(projectId, name, value);
      onChanged(await fetchDemoSecrets(projectId));
      toast.success(`${name} saved.`);
      reset();
    } catch (err) {
      showError(describeDemoError(err));
      // A refused value is not kept around in the field.
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      await deleteDemoSecret(projectId, target);
      onChanged(await fetchDemoSecrets(projectId));
      toast.success(`${target} deleted.`);
    } catch (err) {
      showError(describeDemoError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <DemoSecretsList
        secrets={secrets}
        isAdmin={isAdmin}
        busy={busy}
        onReplace={(target) => {
          setName(target);
          setValue('');
          setReplacing(true);
        }}
        onDelete={(target) => void remove(target)}
      />
      {isAdmin ? (
        <DemoSecretForm
          name={name}
          value={value}
          busy={busy}
          replacing={replacing}
          onNameChange={setName}
          onValueChange={setValue}
          onSubmit={(event) => void submit(event)}
          onCancel={reset}
        />
      ) : (
        <p className="text-ink-3 text-sm">
          Only project administrators can change demo secrets.
        </p>
      )}
    </div>
  );
}
