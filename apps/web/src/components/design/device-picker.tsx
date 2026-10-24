'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Input } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignSettingsView,
  type ViewportPreset,
} from '@nautelle/shared';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../../lib/api';
import {
  blankDraft,
  checkOneOffDevice,
  checkSavedDevice,
  chosenDevices,
  type DeviceDraft,
  deviceOptions,
  initialSelection,
  readDeviceChoice,
  storeDeviceChoice,
} from '../../lib/design/devices';
import { describeDesignError } from '../../lib/design/format';
import { designSettingsApi } from '../../lib/design/href';

/**
 * The devices a design is drawn for (#887): Desktop, Tablet, Phone and the
 * project's presets, all chosen on the first open and the last choice after
 * that. `Custom size` adds a size for this generation only, or — for a project
 * admin — saves it to the project's presets first, by the same audited write
 * as Settings → Design.
 */
export function DevicePicker({
  projectId,
  presets,
  isAdmin,
  disabled,
  onChange,
}: {
  projectId: string;
  /** The project's presets, as the design reads them. */
  presets: readonly ViewportPreset[];
  isAdmin: boolean;
  disabled: boolean;
  /** The devices to send, whenever the choice changes. */
  onChange: (devices: ViewportPreset[]) => void;
}) {
  const [saved, setSaved] = useState<readonly ViewportPreset[]>(presets);
  useEffect(() => setSaved(presets), [presets]);
  const options = useMemo(() => deviceOptions(saved), [saved]);

  const [selected, setSelected] = useState<string[]>(() =>
    initialSelection(options, null),
  );
  const [oneOff, setOneOff] = useState<ViewportPreset[]>([]);
  // Read after mount, so the first render is the same on the server.
  const [restored, setRestored] = useState(false);
  // Only a project change reads the remembered choice again; a save picks its own.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    setSelected(
      initialSelection(optionsRef.current, readDeviceChoice(projectId)),
    );
    setRestored(true);
  }, [projectId]);
  useEffect(() => {
    if (restored) storeDeviceChoice(projectId, selected);
  }, [projectId, selected, restored]);

  const devices = useMemo(
    () => chosenDevices(options, selected, oneOff),
    [options, selected, oneOff],
  );
  useEffect(() => onChange(devices), [devices, onChange]);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DeviceDraft>(blankDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggle = (name: string, on: boolean) =>
    setSelected((s) =>
      on ? (s.includes(name) ? s : [...s, name]) : s.filter((n) => n !== name),
    );

  const reset = () => {
    setDraft(blankDraft());
    setError(null);
    setOpen(false);
  };

  const useOnce = () => {
    const check = checkOneOffDevice(
      draft,
      [...options, ...oneOff].map((d) => d.name),
      devices.length,
    );
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setOneOff((o) => [...o, check.device]);
    reset();
  };

  const saveDevice = async () => {
    setSaving(true);
    try {
      // The write replaces the list, so it starts from the current one.
      const settings = await api<DesignSettingsView>(
        designSettingsApi(projectId),
      );
      const check = checkSavedDevice(draft, settings.viewports);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      await api(designSettingsApi(projectId), {
        method: 'PUT',
        body: {
          viewports: check.presets,
          defaultSkills: settings.defaultSkills,
          useMemory: settings.useMemory,
        },
      });
      setSaved(check.presets);
      setSelected((s) => [...s, check.device.name]);
      toast.success(`Saved ${check.device.name} as a device`);
      reset();
    } catch (failure) {
      setError(errorText(describeDesignError(failure, projectId)));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<DeviceDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  return (
    <fieldset
      aria-labelledby="design-devices"
      className="flex min-w-0 flex-col gap-3 rounded-control border border-line p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span id="design-devices" className="text-sm font-medium">
          Devices
        </span>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="max-lg:h-11"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? reset() : setOpen(true))}
        >
          Custom size
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {options.map((d) => (
          <li key={d.name}>
            <Checkbox
              label={`${d.name} · ${d.width} × ${d.height}`}
              checked={selected.includes(d.name)}
              disabled={disabled}
              onChange={(e) => toggle(d.name, e.target.checked)}
            />
          </li>
        ))}
        {oneOff.map((d) => (
          <li key={d.name} className="flex items-center justify-between gap-2">
            <span className="text-sm">
              {d.name} · {d.width} × {d.height}
              <span className="text-ink-3"> — this generation only</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon
              aria-label={`Remove ${d.name}`}
              disabled={disabled}
              onClick={() =>
                setOneOff((o) => o.filter((x) => x.name !== d.name))
              }
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      {devices.length === 0 ? (
        <p role="alert" className="text-xs text-danger">
          Choose at least one device.
        </p>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Custom size name"
              placeholder="Name"
              className="w-full sm:w-36"
              value={draft.name}
              aria-invalid={error ? true : undefined}
              onChange={(e) => set({ name: e.target.value })}
            />
            <NumberInput
              aria-label="Custom size width"
              className="w-24"
              min={DESIGN_VIEWPORT_MIN_PX}
              max={DESIGN_VIEWPORT_MAX_PX}
              value={draft.width}
              onChange={(e) => set({ width: e.target.value })}
            />
            <span aria-hidden="true" className="text-ink-3">
              ×
            </span>
            <NumberInput
              aria-label="Custom size height"
              className="w-24"
              min={DESIGN_VIEWPORT_MIN_PX}
              max={DESIGN_VIEWPORT_MAX_PX}
              value={draft.height}
              onChange={(e) => set({ height: e.target.value })}
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="glass"
              className="max-lg:h-11"
              disabled={saving}
              onClick={useOnce}
            >
              Use once
            </Button>
            {isAdmin ? (
              <Button
                type="button"
                size="sm"
                variant="glass"
                className="max-lg:h-11"
                disabled={saving}
                onClick={() => void saveDevice()}
              >
                {saving ? 'Saving…' : 'Save as device'}
              </Button>
            ) : null}
          </div>
          {isAdmin ? null : (
            <p className="text-xs text-ink-3">
              Only a project admin can save a device.
            </p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
