import 'reflect-metadata';
import { DESIGN_VIEWPORTS_MAX } from '@nautelle/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CardDesignGenerateDto, DesignGenerateDto } from './dto';

/** #863: the devices a Generate draws for, optional and capped. */
const errorsFor = (
  dto: typeof DesignGenerateDto | typeof CardDesignGenerateDto,
  body: object,
) =>
  validateSync(plainToInstance(dto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

const device = (i: number) => ({
  name: `Device ${i}`,
  width: 320 + i,
  height: 640,
});

describe.each([
  ['DesignGenerateDto', DesignGenerateDto],
  ['CardDesignGenerateDto', CardDesignGenerateDto],
] as const)('%s devices', (_, dto) => {
  it('accepts no body and no devices', () => {
    expect(errorsFor(dto, {})).toEqual([]);
  });

  it('accepts devices up to the cap, a theme included', () => {
    expect(
      errorsFor(dto, {
        devices: [device(1), { ...device(2), theme: 'dark' }],
      }),
    ).toEqual([]);
    const full = Array.from({ length: DESIGN_VIEWPORTS_MAX }, (_, i) =>
      device(i),
    );
    expect(errorsFor(dto, { devices: full })).toEqual([]);
  });

  it('refuses an empty list and one over the cap', () => {
    expect(errorsFor(dto, { devices: [] })).toContain('devices');
    const over = Array.from({ length: DESIGN_VIEWPORTS_MAX + 1 }, (_, i) =>
      device(i),
    );
    expect(errorsFor(dto, { devices: over })).toContain('devices');
  });

  it('refuses a device with a bad width, a bad theme or an unknown field', () => {
    expect(errorsFor(dto, { devices: [{ ...device(1), width: 1 }] })).toContain(
      'devices',
    );
    expect(
      errorsFor(dto, { devices: [{ ...device(1), theme: 'sepia' }] }),
    ).toContain('devices');
    expect(
      errorsFor(dto, { devices: [{ ...device(1), dpr: 2 }] }),
    ).toContain('devices');
    expect(errorsFor(dto, { devices: 'Phone' })).toContain('devices');
  });
});

describe('CardDesignGenerateDto', () => {
  it('keeps the launch fields beside the devices', () => {
    expect(
      errorsFor(CardDesignGenerateDto, {
        profileKey: 'p',
        devices: [device(1)],
      }),
    ).toEqual([]);
  });
});
