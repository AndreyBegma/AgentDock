import { describe, expect, test } from 'bun:test';
import { mobilePreset, PREVIEW_CROP_PX, previewBox } from './mobile-preview';

describe('mobilePreset', () => {
  test('the default presets give Mobile at 390', () => {
    expect(mobilePreset([])).toEqual({
      name: 'Mobile',
      width: 390,
      height: 844,
    });
  });

  test("a project's own Mobile preset wins, whatever the case", () => {
    const own = { name: 'mobile', width: 412, height: 915 };
    expect(
      mobilePreset([{ name: 'Desktop', width: 1440, height: 900 }, own]),
    ).toBe(own);
  });

  test('without a preset named Mobile, the narrowest one', () => {
    const narrow = { name: 'Phone', width: 360, height: 740 };
    expect(
      mobilePreset([
        { name: 'Desktop', width: 1440, height: 900 },
        narrow,
        { name: 'Tablet', width: 820, height: 1180 },
      ]),
    ).toBe(narrow);
  });
});

describe('previewBox', () => {
  test('390 px in a 343 px container is drawn at 87 %', () => {
    expect(previewBox({ width: 390, height: 844 }, 343).scale).toBe(0.87);
  });

  test('never upscales and is cropped to the preview height', () => {
    const box = previewBox({ width: 390, height: 844 }, 600);
    expect(box.scale).toBe(1);
    expect(box.height).toBe(PREVIEW_CROP_PX);
  });

  test('a short mockup keeps its scaled height', () => {
    expect(previewBox({ width: 390, height: 200 }, 195).height).toBe(100);
  });
});
