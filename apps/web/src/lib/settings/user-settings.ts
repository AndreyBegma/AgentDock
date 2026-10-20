'use client';

import {
  PLANNING_MODEL_DEFAULT,
  type UpdateUserSettingsRequest,
  type UserSettingsView,
} from '@nautelle/shared';
import { api } from '../api';
import { useSection } from '../section/use-section';

/** A person's own settings (#337 D9): `GET/PUT /me/settings`. */
export const USER_SETTINGS_API = '/me/settings';

export const fetchUserSettings = () => api<UserSettingsView>(USER_SETTINGS_API);

export const saveUserSettings = (body: UpdateUserSettingsRequest) =>
  api<UserSettingsView>(USER_SETTINGS_API, { method: 'PUT', body });

/**
 * The model New Card and New Plan preselect: the person's setting, else the
 * default while it loads or when it cannot be read — a start is never held
 * up by the setting.
 */
export const preselectedModel = (
  settings: UserSettingsView | undefined,
): string => settings?.planningModel || PLANNING_MODEL_DEFAULT;

export function useUserSettings(enabled = true) {
  return useSection<UserSettingsView | undefined>(
    () => (enabled ? fetchUserSettings() : Promise.resolve(undefined)),
    [enabled],
  );
}
