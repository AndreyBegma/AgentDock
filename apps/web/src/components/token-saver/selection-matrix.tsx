'use client';

import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { CARD_TYPES } from '@nautelle/shared';
import {
  CARD_TYPE_LABEL,
  mcpForType,
  setMcpForType,
  setSkillOffForType,
} from '../../lib/token-saver/prefix';

type ByType = Partial<Record<string, string[]>>;

/**
 * #751 B5 "UI": what a session of each card type loads — which of the allowed
 * MCP servers, and which skills are hidden. A type without a list loads every
 * allowed server and hides no skill. The selection applies in the
 * `prefix-select` test arm and is frozen when a session starts.
 */
export function SelectionMatrix({
  allow,
  skills,
  mcpByType,
  skillsOffByType,
  disabled,
  onMcpChange,
  onSkillsChange,
}: {
  /** The servers the project allows now (the unsaved ticks). */
  allow: readonly string[];
  /** Skills the runner reported in launch prefixes, plus those already hidden. */
  skills: readonly string[];
  mcpByType: ByType;
  skillsOffByType: ByType;
  disabled: boolean;
  onMcpChange: (next: ByType) => void;
  onSkillsChange: (next: ByType) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="font-medium text-sm">Selection per card type</legend>
      <p className="text-ink-3 text-xs">
        A card session loads only what is ticked for its type, and keeps it for
        the whole session. Servers can only be picked from the allowlist above.
        {skills.length === 0
          ? ' No skill has been reported in a launch yet, so none can be hidden.'
          : null}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {CARD_TYPES.map((type) => {
          const servers = mcpForType(mcpByType, type, allow).filter((n) =>
            allow.includes(n),
          );
          const hidden = skillsOffByType[type] ?? [];
          return (
            <fieldset
              key={type}
              className="flex flex-col gap-2 rounded-lg border border-line p-3"
            >
              <legend className="px-1 text-sm">{CARD_TYPE_LABEL[type]}</legend>
              {allow.length === 0 && skills.length === 0 ? (
                <p className="text-ink-3 text-xs">Nothing to select.</p>
              ) : null}
              {allow.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {allow.map((name) => (
                    <li key={name}>
                      <Checkbox
                        id={`prefix-mcp-${type}-${name}`}
                        label={name}
                        hint="MCP server"
                        checked={servers.includes(name)}
                        onChange={(e) =>
                          onMcpChange(
                            setMcpForType(
                              mcpByType,
                              type,
                              name,
                              e.target.checked,
                              allow,
                            ),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {skills.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {skills.map((name) => (
                    <li key={name}>
                      <Checkbox
                        id={`prefix-skill-${type}-${name}`}
                        label={name}
                        hint="Skill — untick to hide"
                        checked={!hidden.includes(name)}
                        onChange={(e) =>
                          onSkillsChange(
                            setSkillOffForType(
                              skillsOffByType,
                              type,
                              name,
                              !e.target.checked,
                            ),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </fieldset>
  );
}
