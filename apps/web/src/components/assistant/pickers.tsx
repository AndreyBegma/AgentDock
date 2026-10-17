'use client';

import {
  type AssistantModelOption,
  LLM_PROVIDER_INFO,
  type ProjectSummary,
} from '@agentdock/shared';
import { Select } from '@andrewbehma/glass-ui/field';
import {
  AUTO_PROJECT,
  modelKey,
  parseModelKey,
} from '../../lib/assistant/selection';
import type { Choice } from '../../lib/assistant/use-assistant';

/** The project and the model of the next message; Auto and the default are first. */
export function Pickers({
  choice,
  models,
  projects,
  disabled,
  onChoose,
}: {
  choice: Choice;
  models: AssistantModelOption[];
  projects: ProjectSummary[];
  disabled: boolean;
  onChoose: (next: Partial<Choice>) => void;
}) {
  const fallback = models.find((each) => each.isDefault);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Project"
        disabled={disabled}
        value={choice.projectId ?? AUTO_PROJECT}
        className="min-w-0 max-w-44 flex-1"
        onChange={(event) =>
          onChoose({ projectId: event.target.value || null })
        }
      >
        <option value={AUTO_PROJECT}>Auto — from the message</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.displayName}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Model"
        disabled={disabled}
        value={modelKey(choice.provider, choice.model)}
        className="min-w-0 max-w-52 flex-1"
        onChange={(event) => onChoose(parseModelKey(event.target.value))}
      >
        <option value="">
          {fallback ? `Default — ${fallback.model}` : 'Default model'}
        </option>
        {models.map((option) => (
          <option
            key={modelKey(option.provider, option.model)}
            value={modelKey(option.provider, option.model)}
          >
            {option.model} · {LLM_PROVIDER_INFO[option.provider].label}
          </option>
        ))}
      </Select>
    </div>
  );
}
