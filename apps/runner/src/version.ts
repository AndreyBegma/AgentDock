import pkg from '../package.json';

/** The runner's version; `bun build --compile` embeds package.json. */
export const RUNNER_VERSION: string = pkg.version;
