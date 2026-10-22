// @ts-nocheck: a fixture the outline reads as text, never compiled
import { x } from './x';

export interface Options {
  verbose: boolean;
}

export const run = (options: Options): void => {
  const inner = options.verbose;
  function nested() {}
  return void inner;
};

async function load(): Promise<void> {}

@Injectable()
class Service {
  private value = 1;
  public get() {}
}

type Alias = string;

describe('service', () => {
  it('works', () => {});
});

// biome-ignore format: the line must stay long, the outline cuts it
const aVeryLongDeclaration = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
