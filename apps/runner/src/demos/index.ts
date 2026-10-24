import type { CardDemoArgs, CardDemoResult } from '@nautelle/shared/protocol';
import type { DemoRecorder } from './recorder';

export { DemoflowProvisioner } from './provision';
export { DemoRecorder } from './recorder';

/** Demo videos' command (C-369, ADR-0090). */
export interface DemoHandlers {
  'card.demo': (args: CardDemoArgs) => Promise<CardDemoResult>;
}

export const createDemoHandlers = (recorder: DemoRecorder): DemoHandlers => ({
  'card.demo': async (args) => recorder.command(args),
});
