import type { CardPrefix } from '@nautelle/shared';
import type { CardTokenSaver } from '@nautelle/shared/protocol';

/**
 * #751: a card launch's `tokenSaver`, with the session's prefix on it. Only a
 * launch that carries `tokenSaver` at all (a runner with the capability) and
 * a prefix (a runner with `prefixOverlays`) gets the field.
 */
export const withCardPrefix = (
  args: { tokenSaver?: CardTokenSaver },
  prefix: CardPrefix | null,
): { tokenSaver?: CardTokenSaver } =>
  args.tokenSaver && prefix
    ? { tokenSaver: { ...args.tokenSaver, prefix } }
    : args;
