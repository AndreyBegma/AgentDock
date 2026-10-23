import {
  DEFAULT_VIEWPORTS,
  DESIGN_VIEWPORTS_MAX,
  type ViewportPreset,
} from '@nautelle/shared';
import { blankRow, readViewportRows, toRows } from './viewports';

/**
 * The target devices of Generate (#887, ADR-0085): the built-in Desktop,
 * Tablet and Phone, then the project's own presets (Settings → Design). The
 * chosen ones go in the request; a size typed in the panel is either used for
 * one generation or saved as a preset first.
 */

/** A custom size as typed, so a half-typed width is not lost. */
export interface DeviceDraft {
  name: string;
  width: string;
  height: string;
}

export const blankDraft = (): DeviceDraft => {
  const { name, width, height } = blankRow();
  return { name, width, height };
};

/**
 * What the picker lists: the built-ins first, then the project's other
 * presets. A project preset named like a built-in sets that device's size.
 */
export function deviceOptions(
  saved: readonly ViewportPreset[],
): ViewportPreset[] {
  const byName = new Map(saved.map((p) => [p.name, p]));
  const builtIn = DEFAULT_VIEWPORTS.map((p) => byName.get(p.name) ?? p);
  const builtInNames = new Set(DEFAULT_VIEWPORTS.map((p) => p.name));
  return [...builtIn, ...saved.filter((p) => !builtInNames.has(p.name))];
}

/**
 * The names chosen on open: all of them on the first open, then the
 * remembered ones that are still listed.
 */
export function initialSelection(
  options: readonly ViewportPreset[],
  remembered: readonly string[] | null,
): string[] {
  const names = options.map((o) => o.name);
  return remembered === null
    ? names
    : remembered.filter((n) => names.includes(n));
}

/** The devices to send, in the picker's order, then the one-off sizes. */
export function chosenDevices(
  options: readonly ViewportPreset[],
  selected: readonly string[],
  oneOff: readonly ViewportPreset[],
): ViewportPreset[] {
  return [...options.filter((o) => selected.includes(o.name)), ...oneOff];
}

export type DeviceCheck =
  | { ok: true; device: ViewportPreset }
  | { ok: false; error: string };

const asRow = (draft: DeviceDraft) => ({ ...blankRow(), ...draft });

/**
 * A custom size for one generation: a valid preset whose name no listed
 * device has, and room for it in the request.
 */
export function checkOneOffDevice(
  draft: DeviceDraft,
  taken: readonly string[],
  chosenCount: number,
): DeviceCheck {
  const row = asRow(draft);
  const result = readViewportRows([row]);
  if (!result.ok) {
    return { ok: false, error: result.errors[row.key] ?? 'Check the size.' };
  }
  const device = result.presets[0];
  if (taken.includes(device.name)) {
    return { ok: false, error: 'Another device has this name.' };
  }
  if (chosenCount >= DESIGN_VIEWPORTS_MAX) {
    return {
      ok: false,
      error: `At most ${DESIGN_VIEWPORTS_MAX} devices in one generation.`,
    };
  }
  return { ok: true, device };
}

export type SaveDeviceCheck =
  | { ok: true; device: ViewportPreset; presets: ViewportPreset[] }
  | { ok: false; error: string };

/**
 * A custom size added to the project's presets: the row validation of
 * Settings → Design on the whole list, so a taken name or a full list is
 * refused here the same way. Nothing is saved when it fails.
 */
export function checkSavedDevice(
  draft: DeviceDraft,
  saved: readonly ViewportPreset[],
): SaveDeviceCheck {
  const row = asRow(draft);
  const result = readViewportRows([...toRows(saved), row]);
  if (!result.ok) {
    return {
      ok: false,
      error: result.errors[row.key] ?? result.listError ?? 'Check the size.',
    };
  }
  return {
    ok: true,
    device: result.presets[result.presets.length - 1],
    presets: result.presets,
  };
}

// The last choice, remembered per project in this browser.

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;

const choiceKey = (projectId: string): string =>
  `nautelle:design-devices:${projectId}`;

const storageOrNull = (): ChoiceStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The remembered device names; null when none, or storage is blocked. */
export function readDeviceChoice(
  projectId: string,
  storage: ChoiceStorage | null = storageOrNull(),
): string[] | null {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(choiceKey(projectId)) ?? 'null',
    );
    return Array.isArray(parsed) &&
      parsed.every((n): n is string => typeof n === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Remembers the choice; when storage is blocked it lasts for this page. */
export function storeDeviceChoice(
  projectId: string,
  names: readonly string[],
  storage: ChoiceStorage | null = storageOrNull(),
): void {
  try {
    storage?.setItem(choiceKey(projectId), JSON.stringify(names));
  } catch {
    // Not remembered: every device is preselected next time.
  }
}
