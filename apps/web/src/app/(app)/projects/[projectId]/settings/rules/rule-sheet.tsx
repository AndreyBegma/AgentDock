'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  CARD_TYPES,
  type CardType,
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_TITLE_MAX,
  type ProjectRuleView,
} from '@nautelle/shared';
import { useEffect, useState } from 'react';
import {
  SOURCE_LABEL,
  sameCardTypes,
  toggleCardType,
} from '../../../../../../lib/project-rules/format';
import { CARD_TYPE_LABEL } from '../../../../../../lib/token-saver/prefix';

export interface RuleDraft {
  title: string;
  description: string;
  enabled: boolean;
  /** #751 B5: the card types it applies to; empty is all. */
  appliesTo: CardType[];
}

const EMPTY_DRAFT: RuleDraft = {
  title: '',
  description: '',
  enabled: true,
  appliesTo: [],
};

/**
 * The editor for one rule. `rule` undefined is a new rule; `readOnly` shows
 * the fields without a way to change them (a member who cannot edit).
 */
export function RuleSheet({
  open,
  rule,
  readOnly,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  rule?: ProjectRuleView;
  readOnly: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: RuleDraft) => void;
  onDelete: (rule: ProjectRuleView) => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setDraft(
      rule
        ? {
            title: rule.title,
            description: rule.description,
            enabled: rule.enabled,
            appliesTo: rule.appliesTo,
          }
        : EMPTY_DRAFT,
    );
  }, [open, rule]);

  const title = draft.title.trim();
  const titleError =
    touched && title === ''
      ? 'Give the rule a short name; agents see it in bold.'
      : undefined;
  const changed =
    !rule ||
    title !== rule.title ||
    draft.description.trim() !== rule.description ||
    draft.enabled !== rule.enabled ||
    !sameCardTypes(draft.appliesTo, rule.appliesTo);

  return (
    <SheetRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        title={rule ? rule.title : 'New rule'}
        description={
          readOnly
            ? 'You can read this rule; only a project administrator can change it.'
            : undefined
        }
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            {rule && !readOnly ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => onDelete(rule)}
              >
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                {readOnly ? 'Close' : 'Cancel'}
              </Button>
              {readOnly ? null : (
                <Button
                  variant="solid"
                  disabled={busy || title === '' || !changed}
                  onClick={() => onSave({ ...draft, title })}
                >
                  {rule ? 'Save' : 'Add rule'}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label={`Name (${draft.title.length} / ${PROJECT_RULE_TITLE_MAX})`}
            htmlFor="rule-title"
            required
            error={titleError}
          >
            <Input
              id="rule-title"
              value={draft.title}
              maxLength={PROJECT_RULE_TITLE_MAX}
              readOnly={readOnly}
              aria-invalid={titleError ? true : undefined}
              onBlur={() => setTouched(true)}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field
            label={`Description (${draft.description.length} / ${PROJECT_RULE_DESCRIPTION_MAX})`}
            htmlFor="rule-description"
            hint="Write it as an instruction to the agent. Markdown is allowed."
          >
            <Textarea
              id="rule-description"
              rows={6}
              value={draft.description}
              maxLength={PROJECT_RULE_DESCRIPTION_MAX}
              readOnly={readOnly}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </Field>
          <div
            className="flex items-center gap-3"
            inert={readOnly || undefined}
          >
            <Toggle
              labelledBy="rule-enabled-label"
              checked={draft.enabled}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <span id="rule-enabled-label" className="text-sm">
              Enabled — include in agent prompts
            </span>
          </div>
          <fieldset
            className="flex flex-col gap-2"
            disabled={readOnly}
            // A new rule is created for every type; narrow it once it exists.
            hidden={!rule}
          >
            <legend className="font-medium text-sm">Applies to</legend>
            <p className="text-ink-3 text-xs">
              In the Token saver test arm a card session gets only the rules
              that apply to its type. None ticked means every type.
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              {CARD_TYPES.map((type) => (
                <li key={type}>
                  <Checkbox
                    id={`rule-applies-${type}`}
                    label={CARD_TYPE_LABEL[type]}
                    checked={draft.appliesTo.includes(type)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        appliesTo: toggleCardType(
                          draft.appliesTo,
                          type,
                          e.target.checked,
                        ),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </fieldset>
          {rule ? (
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2">
                <dt className="w-20 text-ink-2">Source</dt>
                <dd>
                  <Badge label={SOURCE_LABEL[rule.source]} />
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="w-20 text-ink-2">Created</dt>
                <dd>{new Date(rule.createdAt).toLocaleDateString()}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="w-20 text-ink-2">Updated</dt>
                <dd>{new Date(rule.updatedAt).toLocaleDateString()}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </SheetContent>
    </SheetRoot>
  );
}
