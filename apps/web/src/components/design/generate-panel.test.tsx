import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VIEWPORTS,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORTS_MAX,
  STACK_GATE_REASON,
  type ViewportPreset,
} from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  checkOneOffDevice,
  checkSavedDevice,
  chosenDevices,
  type DeviceDraft,
  deviceOptions,
  initialSelection,
  readDeviceChoice,
  storeDeviceChoice,
} from '../../lib/design/devices';
import { design } from '../../lib/design/fixtures';
import { UserProvider } from '../shell/user-context';
import { GeneratePanel } from './generate-panel';

const render = (stackBlock: string | null) =>
  renderToStaticMarkup(
    <UserProvider
      value={{
        id: 'u1',
        email: 'op@example.com',
        name: null,
        role: 'operator',
        status: 'active',
        twoFactorEnabled: false,
      }}
    >
      <GeneratePanel
        projectId="p1"
        design={design({ revisions: [], status: 'idle', profileId: null })}
        writeBlock={null}
        stackBlock={stackBlock}
        stackHref="/projects/p1/board/stacks/1/design"
        busy={false}
        onPatch={async () => {}}
        onGenerate={async () => {}}
      />
    </UserProvider>,
  );

describe('GeneratePanel (#527)', () => {
  test("a stack card's Generate is disabled with the stack design's reason", () => {
    const html = render(`${STACK_GATE_REASON}: S-1 “Redesign”.`);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="design-stack-reason"/,
    );
    expect(html).toContain(STACK_GATE_REASON);
    expect(html).toContain('href="/projects/p1/board/stacks/1/design"');
  });

  test('without a stack block Generate is not held by the stack', () => {
    const html = render(null);
    expect(html).not.toContain('design-stack-reason');
    expect(html).not.toContain(STACK_GATE_REASON);
  });
});

describe('GeneratePanel (#606)', () => {
  test('a design not drawn yet does not claim the project has no UI profile', () => {
    // `profileId` is the design's, null until a revision is drawn; the
    // project's profile status is what says a build comes first.
    const html = render(null);
    expect(html).not.toContain('no UI profile yet');
  });
});

describe('GeneratePanel devices (#887)', () => {
  const html = (viewports: ViewportPreset[]) =>
    renderToStaticMarkup(
      <UserProvider
        value={{
          id: 'u1',
          email: 'op@example.com',
          name: null,
          role: 'operator',
          status: 'active',
          twoFactorEnabled: false,
        }}
      >
        <GeneratePanel
          projectId="p1"
          design={design({ revisions: [], status: 'idle', viewports })}
          writeBlock={null}
          busy={false}
          onPatch={async () => {}}
          onGenerate={async () => {}}
        />
      </UserProvider>,
    );

  test('lists the built-ins and the custom devices, all preselected', () => {
    const out = html([
      ...DEFAULT_VIEWPORTS,
      { name: 'Kiosk', width: 1080, height: 1920 },
    ]);
    for (const label of ['Desktop · 1440', 'Tablet · 834', 'Phone · 390']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('Kiosk · 1080 × 1920');
    expect(out.match(/type="checkbox"[^>]*checked=""/g)?.length).toBe(4);
    expect(out).not.toContain('Choose at least one device.');
  });

  test('a project that replaced the presets still offers the built-ins', () => {
    const out = html([{ name: 'Wall', width: 3840, height: 2160 }]);
    expect(out).toContain('Desktop · 1440');
    expect(out).toContain('Wall · 3840 × 2160');
  });
});

describe('device choice (#887)', () => {
  const saved: ViewportPreset[] = [
    { name: 'Kiosk', width: 1080, height: 1920 },
  ];
  const options = deviceOptions(saved);

  test('the first open selects every device, then the remembered ones', () => {
    expect(initialSelection(options, null)).toEqual([
      'Desktop',
      'Tablet',
      'Phone',
      'Kiosk',
    ]);
    expect(initialSelection(options, ['Phone', 'Gone'])).toEqual(['Phone']);
  });

  test('a choice is remembered per project and survives blocked storage', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(readDeviceChoice('p1', storage)).toBeNull();
    storeDeviceChoice('p1', ['Phone'], storage);
    expect(readDeviceChoice('p1', storage)).toEqual(['Phone']);
    expect(readDeviceChoice('p2', storage)).toBeNull();
    expect(readDeviceChoice('p1', null)).toBeNull();
  });

  test('the request carries exactly the selected devices and one-off sizes', () => {
    const once = { name: 'Fold', width: 600, height: 900 };
    expect(chosenDevices(options, ['Kiosk', 'Phone'], [once])).toEqual([
      DEFAULT_VIEWPORTS[2],
      saved[0],
      once,
    ]);
    expect(chosenDevices(options, [], [])).toEqual([]);
  });

  test('a custom size for one generation is checked but not added to the project', () => {
    const ok = checkOneOffDevice(
      { name: ' Fold ', width: '600', height: '900' },
      options.map((o) => o.name),
      2,
    );
    expect(ok).toEqual({
      ok: true,
      device: { name: 'Fold', width: 600, height: 900 },
    });
    expect(
      checkOneOffDevice({ name: '', width: '600', height: '900' }, [], 0).ok,
    ).toBe(false);
    expect(
      checkOneOffDevice({ name: 'X', width: '5', height: '900' }, [], 0).ok,
    ).toBe(false);
    expect(
      checkOneOffDevice(
        { name: 'Phone', width: '600', height: '900' },
        ['Phone'],
        0,
      ),
    ).toEqual({ ok: false, error: 'Another device has this name.' });
    expect(
      checkOneOffDevice(
        { name: 'Fold', width: '600', height: '900' },
        [],
        DESIGN_VIEWPORTS_MAX,
      ).ok,
    ).toBe(false);
  });

  test('saving adds the size to the end of the project presets', () => {
    const check = checkSavedDevice(
      { name: 'Fold', width: '600', height: '900' },
      saved,
    );
    expect(check).toEqual({
      ok: true,
      device: { name: 'Fold', width: 600, height: 900 },
      presets: [...saved, { name: 'Fold', width: 600, height: 900 }],
    });
  });

  test('an invalid name or size, a taken name or a full list saves nothing', () => {
    const bad = (draft: DeviceDraft, list: ViewportPreset[] = saved) =>
      checkSavedDevice(draft, list);
    expect(bad({ name: '', width: '600', height: '900' }).ok).toBe(false);
    expect(bad({ name: 'A', width: 'abc', height: '900' }).ok).toBe(false);
    expect(
      bad({ name: 'A', width: String(DESIGN_VIEWPORT_MAX_PX + 1), height: '9' })
        .ok,
    ).toBe(false);
    expect(bad({ name: 'Kiosk', width: '600', height: '900' })).toEqual({
      ok: false,
      error: 'Another preset has this name.',
    });
    const full = Array.from({ length: DESIGN_VIEWPORTS_MAX }, (_, i) => ({
      name: `D${i}`,
      width: 600,
      height: 900,
    }));
    expect(bad({ name: 'Extra', width: '600', height: '900' }, full)).toEqual({
      ok: false,
      error: `At most ${DESIGN_VIEWPORTS_MAX} presets.`,
    });
  });
});
