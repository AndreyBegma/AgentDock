import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProjectDto } from './dto';

const errorsFor = (baseOverride: string) =>
  validateSync(plainToInstance(UpdateProjectDto, { baseOverride })).map(
    (e) => e.property,
  );

describe('UpdateProjectDto baseOverride', () => {
  it('refuses a branch with a leading dash, which git reads as an option', () => {
    expect(errorsFor('-x')).toContain('baseOverride');
    expect(errorsFor('--upload-pack=evil')).toContain('baseOverride');
  });

  it('accepts an ordinary branch, dashes inside included', () => {
    expect(errorsFor('develop')).toEqual([]);
    expect(errorsFor('feat/my-branch')).toEqual([]);
  });

  it('still refuses `..` and whitespace', () => {
    expect(errorsFor('a..b')).toContain('baseOverride');
    expect(errorsFor('a b')).toContain('baseOverride');
  });
});
