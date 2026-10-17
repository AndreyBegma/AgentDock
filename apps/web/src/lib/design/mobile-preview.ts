import { DEFAULT_VIEWPORTS, type ViewportPreset } from '@agentdock/shared';
import { fitZoom } from './zoom';

/** The cropped preview's height on a phone, in px. */
export const PREVIEW_CROP_PX = 340;

/**
 * #526: the preset the phone preview is drawn at — the one named `Mobile`
 * (the project's own or the default), else the narrowest preset.
 */
export function mobilePreset(
  viewports: readonly ViewportPreset[],
): ViewportPreset {
  const presets = viewports.length > 0 ? viewports : DEFAULT_VIEWPORTS;
  return (
    presets.find((p) => p.name.toLowerCase() === 'mobile') ??
    presets.reduce((narrow, p) => (p.width < narrow.width ? p : narrow))
  );
}

/**
 * The preview's scale: the preset's width fitted to the container, as the
 * viewer's Fit does, and the box height the scaled mockup takes, capped at
 * the crop.
 */
export function previewBox(
  preset: Pick<ViewportPreset, 'width' | 'height'>,
  available: number,
): { scale: number; height: number } {
  const scale = fitZoom(available, preset.width);
  return {
    scale,
    height: Math.min(PREVIEW_CROP_PX, Math.round(preset.height * scale)),
  };
}
