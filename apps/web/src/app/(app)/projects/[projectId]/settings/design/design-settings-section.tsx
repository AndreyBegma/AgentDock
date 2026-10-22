'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { Input, Select } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  DEFAULT_VIEWPORTS,
  DESIGN_SKILLS_MAX,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignSettingsView,
  type DesignTheme,
  type InstalledSkillsView,
} from '@nautelle/shared';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import { api } from '../../../../../../lib/api';
import { describeDesignError } from '../../../../../../lib/design/format';
import {
  designSettingsApi,
  installedSkillsApi,
} from '../../../../../../lib/design/href';
import {
  blankRow,
  canAddRow,
  moveRow,
  readViewportRows,
  toRows,
  type ViewportRow,
} from '../../../../../../lib/design/viewports';
import { Time } from '../../../../../../lib/format/time';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../lib/section/use-section';

const THEME_OPTION: Record<DesignTheme | '', string> = {
  '': 'Light and dark',
  light: 'Light only',
  dark: 'Dark only',
};

/**
 * Settings → Design → viewport presets, default design skills (spec 223
 * D11, D15) and the design memory switch (#752 A6). Every member reads
 * them; a project admin saves them at once, as the API takes them.
 */
export function DesignSettingsSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const settings = useSection(
    () => api<DesignSettingsView>(designSettingsApi(projectId)),
    [projectId],
  );
  return (
    <AsyncSection
      section={settings}
      unavailable={{
        title: 'The design settings could not be loaded',
        stillWorks: 'Designs keep using the saved presets.',
      }}
      empty={null}
    >
      {(data) => (
        <SettingsForm
          projectId={projectId}
          isAdmin={isAdmin}
          data={data}
          onSaved={settings.retry}
        />
      )}
    </AsyncSection>
  );
}

function SettingsForm({
  projectId,
  isAdmin,
  data,
  onSaved,
}: {
  projectId: string;
  isAdmin: boolean;
  data: DesignSettingsView;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<ViewportRow[]>(() => toRows(data.viewports));
  const [skills, setSkills] = useState<string[]>(data.defaultSkills);
  const [useMemory, setUseMemory] = useState(data.useMemory);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  useEffect(() => {
    setRows(toRows(data.viewports));
    setSkills(data.defaultSkills);
    setUseMemory(data.useMemory);
  }, [data]);

  const installed = useSection(
    () => api<InstalledSkillsView>(installedSkillsApi(projectId)),
    [projectId],
  );
  const installedNames = useMemo(
    () => new Set((installed.data?.items ?? []).map((s) => s.invocation)),
    [installed.data],
  );
  const options = useMemo(
    () =>
      [...new Set([...installedNames, ...skills])]
        .sort()
        .map((name) => ({ value: name, label: name })),
    [installedNames, skills],
  );
  // D15: a default that is no longer installed is skipped on every design.
  const gone = installed.data
    ? skills.filter((s) => !installedNames.has(s))
    : [];

  const update = (key: string, patch: Partial<ViewportRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    const result = readViewportRows(rows);
    if (!result.ok) {
      setErrors(result.errors);
      setListError(result.listError);
      return;
    }
    setErrors({});
    setListError(null);
    setBusy(true);
    try {
      await api(designSettingsApi(projectId), {
        method: 'PUT',
        body: { viewports: result.presets, defaultSkills: skills, useMemory },
      });
      toast.success('Design settings saved');
      onSaved();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section
        aria-labelledby="design-viewports"
        className="flex flex-col gap-3"
      >
        <SectionHeader
          headingId="design-viewports"
          title="Viewport presets"
          description={
            <>
              The screens the viewer offers, in this order.
              {data.saved ? null : ' These are the defaults.'}
              {isAdmin ? '' : ' Only a project admin can change them.'}
            </>
          }
        />
        <ul className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <li key={row.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Preset ${i + 1} name`}
                  // A row of its own on a phone; the sizes wrap under it.
                  className="w-full sm:w-36"
                  value={row.name}
                  disabled={!isAdmin}
                  aria-invalid={errors[row.key] ? true : undefined}
                  onChange={(e) => update(row.key, { name: e.target.value })}
                />
                <NumberInput
                  aria-label={`Preset ${i + 1} width`}
                  className="w-24"
                  min={DESIGN_VIEWPORT_MIN_PX}
                  max={DESIGN_VIEWPORT_MAX_PX}
                  value={row.width}
                  disabled={!isAdmin}
                  onChange={(e) => update(row.key, { width: e.target.value })}
                />
                <span aria-hidden="true" className="text-ink-3">
                  ×
                </span>
                <NumberInput
                  aria-label={`Preset ${i + 1} height`}
                  className="w-24"
                  min={DESIGN_VIEWPORT_MIN_PX}
                  max={DESIGN_VIEWPORT_MAX_PX}
                  value={row.height}
                  disabled={!isAdmin}
                  onChange={(e) => update(row.key, { height: e.target.value })}
                />
                <Select
                  aria-label={`Preset ${i + 1} theme`}
                  className="w-auto"
                  value={row.theme}
                  disabled={!isAdmin}
                  onChange={(e) =>
                    update(row.key, {
                      theme: e.target.value as ViewportRow['theme'],
                    })
                  }
                >
                  {(['', 'light', 'dark'] as const).map((t) => (
                    <option key={t} value={t}>
                      {THEME_OPTION[t]}
                    </option>
                  ))}
                </Select>
                {isAdmin ? (
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Move ${row.name || `preset ${i + 1}`} up`}
                      disabled={i === 0}
                      onClick={() => setRows((rs) => moveRow(rs, i, -1))}
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Move ${row.name || `preset ${i + 1}`} down`}
                      disabled={i === rows.length - 1}
                      onClick={() => setRows((rs) => moveRow(rs, i, 1))}
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Remove ${row.name || `preset ${i + 1}`}`}
                      onClick={() =>
                        setRows((rs) => rs.filter((r) => r.key !== row.key))
                      }
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </span>
                ) : null}
              </div>
              {errors[row.key] ? (
                <p role="alert" className="text-xs text-danger">
                  {errors[row.key]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {listError ? (
          <p role="alert" className="text-xs text-danger">
            {listError}
          </p>
        ) : null}
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="glass"
              disabled={!canAddRow(rows)}
              onClick={() => setRows((rs) => [...rs, blankRow()])}
            >
              Add preset
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRows(toRows(DEFAULT_VIEWPORTS))}
            >
              Use the defaults
            </Button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="design-skills" className="flex flex-col gap-3">
        <SectionHeader
          headingId="design-skills"
          title="Default design skills"
          description={`Installed skills the planner applies when it draws a mockup; each design can change them before it is generated. Up to ${DESIGN_SKILLS_MAX}.`}
        />
        <Combobox
          multiple
          aria-label="Default design skills"
          options={options}
          value={skills}
          disabled={!isAdmin}
          placeholder="Add a skill"
          onValueChange={(next) => setSkills(next.slice(0, DESIGN_SKILLS_MAX))}
        />
        {installed.error ? (
          <p className="text-xs text-ink-3">
            The installed skills could not be listed; the chosen ones are kept.
          </p>
        ) : null}
        {gone.length > 0 ? (
          <Banner tone="warn" title="Not installed any more">
            {gone.join(', ')} — skipped on every design until reinstalled or
            removed here.
          </Banner>
        ) : null}
      </section>

      <section aria-labelledby="design-memory" className="flex flex-col gap-3">
        <SectionHeader
          headingId="design-memory"
          title="Design memory"
          description="After each approval the UI profile learns the approved screen, the style rules its comments settled and any new snippets — whether this is on or off. On, every new design starts from them."
        />
        <div className="flex items-center gap-3 text-sm">
          {isAdmin ? (
            <Toggle
              labelledBy="design-memory-switch"
              checked={useMemory}
              onChange={setUseMemory}
            />
          ) : null}
          <span id="design-memory-switch">
            Use approved screens and style rules in new designs
            {isAdmin ? null : (
              <span className="text-ink-3">
                {` — ${useMemory ? 'on' : 'off'}. Only a project admin can change it.`}
              </span>
            )}
          </span>
        </div>
      </section>

      {isAdmin ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-ink-3">
            {data.updatedAt ? (
              <>
                Saved <Time value={data.updatedAt} />
                {data.updatedBy ? ` by ${data.updatedBy.name}` : ''}
              </>
            ) : null}
          </span>
          <Button type="submit" variant="solid" disabled={busy}>
            {busy ? 'Saving…' : 'Save design settings'}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
