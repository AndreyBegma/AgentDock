'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Field } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  PREFIX_BUDGET_MAX_TOKENS,
  PREFIX_BUDGET_MIN_TOKENS,
  type ProjectRuntimeProfile,
  type TokenSaverSettingsView,
} from '@nautelle/shared';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { BShareCard } from '../../../../../components/token-saver/b-share-card';
import { SelectionMatrix } from '../../../../../components/token-saver/selection-matrix';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import {
  fetchRuntimeProfiles,
  fetchTokenSaver,
  saveTokenSaver,
} from '../../../../../lib/token-saver/actions';
import {
  describeTokenSaverError,
  mcpChoices,
  profilesReportServers,
  sameAllow,
  toggleAllow,
} from '../../../../../lib/token-saver/format';
import {
  fetchPrefixSummary,
  pruneMcpByType,
  sameByType,
  skillChoices,
} from '../../../../../lib/token-saver/prefix';
import { presetRange } from '../../../../../lib/usage/format';

type ByType = Partial<Record<string, string[]>>;

/**
 * #445 D11: the project's Token saver — a switch (on by default) and the MCP
 * allowlist (D6). A project admin saves; everyone else reads. The allowlist
 * is picked from the servers the runner reports for the project's profiles,
 * which only an operator can read. #746: below it, the share of new cards
 * in test arm B.
 */
export function TokenSaverTab({
  projectId,
  isAdmin,
  canOperate,
}: {
  projectId: string;
  isAdmin: boolean;
  canOperate: boolean;
}) {
  const [settings, setSettings] = useState<TokenSaverSettingsView>();
  const [profiles, setProfiles] = useState<ProjectRuntimeProfile[]>();
  const [enabled, setEnabled] = useState(true);
  const [allow, setAllow] = useState<string[]>([]);
  const [budget, setBudget] = useState('');
  const [mcpByType, setMcpByType] = useState<ByType>({});
  const [skillsOffByType, setSkillsOffByType] = useState<ByType>({});
  const [reportedSkills, setReportedSkills] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const adopt = useCallback((view: TokenSaverSettingsView) => {
    setSettings(view);
    setEnabled(view.enabled);
    setAllow(view.mcpAllow);
    setBudget(String(view.prefixBudgetTokens));
    setMcpByType(view.mcpByType);
    setSkillsOffByType(view.skillsOffByType);
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await fetchTokenSaver(projectId));
    } catch (err) {
      showError(describeTokenSaverError(err));
    }
  }, [projectId, showError, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  // The skills a launch reported: the top parts of the last 30 days. Best
  // effort — without them the matrix shows only the skills already hidden.
  useEffect(() => {
    let current = true;
    fetchPrefixSummary(projectId, presetRange('30d'))
      .then((summary) => {
        if (!current) return;
        setReportedSkills(
          summary.topParts.filter((p) => p.kind === 'skill').map((p) => p.name),
        );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!canOperate) {
      setProfiles([]);
      return;
    }
    let current = true;
    fetchRuntimeProfiles(projectId)
      .then((list) => {
        if (current) setProfiles(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // The checkboxes fall back to the stored names; saving still works.
        if (current) setProfiles([]);
      });
    return () => {
      current = false;
    };
  }, [projectId, canOperate]);

  if (!settings || !profiles) return <Skeleton className="h-64 w-full" />;

  const choices = mcpChoices(profiles, allow);
  const budgetValue = Number(budget);
  const budgetError =
    !Number.isInteger(budgetValue) ||
    budgetValue < PREFIX_BUDGET_MIN_TOKENS ||
    budgetValue > PREFIX_BUDGET_MAX_TOKENS
      ? `Enter a whole number from ${PREFIX_BUDGET_MIN_TOKENS.toLocaleString('en-US')} to ${PREFIX_BUDGET_MAX_TOKENS.toLocaleString('en-US')}.`
      : undefined;
  // A server unticked in the allowlist leaves every type's list (the API
  // refuses a subset that is not within `mcpAllow`).
  const prunedMcp = pruneMcpByType(mcpByType, allow);
  const dirty =
    enabled !== settings.enabled ||
    !sameAllow(allow, settings.mcpAllow) ||
    budgetValue !== settings.prefixBudgetTokens ||
    !sameByType(prunedMcp, settings.mcpByType) ||
    !sameByType(skillsOffByType, settings.skillsOffByType);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (budgetError) return;
    setBusy(true);
    try {
      const view = await saveTokenSaver(projectId, {
        enabled,
        mcpAllow: allow,
        prefixBudgetTokens: budgetValue,
        mcpByType: prunedMcp,
        skillsOffByType,
      });
      adopt(view);
      toast.success('Token saver saved.');
    } catch (err) {
      showError(describeTokenSaverError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card pad="lg">
        <form className="flex flex-col gap-6" onSubmit={save}>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              {/* glass-ui's Toggle has no `disabled`: a locked one is inert and dimmed. */}
              <span
                aria-disabled={!isAdmin || undefined}
                inert={!isAdmin || undefined}
                className={isAdmin ? undefined : 'opacity-60'}
              >
                <Toggle
                  labelledBy="token-saver-enabled"
                  checked={enabled}
                  onChange={(value) => {
                    if (isAdmin) setEnabled(value);
                  }}
                />
              </span>
              <span id="token-saver-enabled">Token saver</span>
            </div>
            <p className="text-ink-3 text-xs">
              Compresses what agents read — command output, unused MCP tool
              schemas, a long history — and never what people read: questions,
              specs, pull-request descriptions and summaries stay complete. Off
              launches every agent exactly as before.{' '}
              <Link
                href={`/projects/${encodeURIComponent(projectId)}/token-saver`}
                className="text-accent-ink underline underline-offset-2"
              >
                See what it saved
              </Link>
              .
            </p>
          </div>

          <fieldset
            className="flex flex-col gap-2"
            disabled={!isAdmin || !enabled}
          >
            <legend className="font-medium text-sm">
              MCP servers agents load
            </legend>
            <p className="text-ink-3 text-xs">
              <code>agentdock</code> is always loaded. A server left unticked is
              not loaded, so its tool schemas cost no tokens.{' '}
              {choices.length === 0
                ? 'None are allowed — agents get agentdock only.'
                : null}
            </p>
            {choices.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {choices.map(({ name, reported }) => (
                  <li key={name}>
                    <Checkbox
                      id={`token-saver-mcp-${name}`}
                      label={name}
                      hint={
                        reported
                          ? undefined
                          : 'Allowed, but no profile of the runner reports it now.'
                      }
                      checked={allow.includes(name)}
                      onChange={(e) =>
                        setAllow((prev) =>
                          toggleAllow(prev, name, e.target.checked),
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {!canOperate ? (
              <p className="text-ink-3 text-xs">
                The runner's servers are listed for operators; you see the names
                already allowed.
              </p>
            ) : !profilesReportServers(profiles) ? (
              <p className="text-ink-3 text-xs">
                The runner reports no MCP servers for this project's profiles —
                an older runner, or a Codex profile. Update the runner to pick
                servers here.
              </p>
            ) : null}
          </fieldset>

          <fieldset className="flex flex-col gap-2" disabled={!isAdmin}>
            <legend className="font-medium text-sm">Prefix budget</legend>
            <Field
              label="Tokens per launch"
              htmlFor="token-saver-prefix-budget"
              hint="A launch kind whose median prefix is over this is flagged on the Token saver page. A warning never blocks a launch."
              error={budgetError}
            >
              <NumberInput
                id="token-saver-prefix-budget"
                className="w-36"
                min={PREFIX_BUDGET_MIN_TOKENS}
                max={PREFIX_BUDGET_MAX_TOKENS}
                value={budget}
                disabled={!isAdmin}
                aria-invalid={budgetError ? true : undefined}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
          </fieldset>

          <SelectionMatrix
            allow={allow}
            skills={skillChoices(reportedSkills, skillsOffByType)}
            mcpByType={prunedMcp}
            skillsOffByType={skillsOffByType}
            disabled={!isAdmin || !enabled}
            onMcpChange={setMcpByType}
            onSkillsChange={setSkillsOffByType}
          />

          {isAdmin ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-3 text-xs">
                {settings.updatedAt ? (
                  <>
                    Last changed <Time value={settings.updatedAt} />
                  </>
                ) : (
                  'Never changed — on, agentdock only.'
                )}
              </span>
              <Button
                variant="solid"
                type="submit"
                disabled={busy || !dirty || budgetError !== undefined}
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-ink-3 text-sm">
              Only project administrators can change Token saver.
            </p>
          )}
        </form>
      </Card>
      <BShareCard projectId={projectId} isAdmin={isAdmin} />
    </div>
  );
}
