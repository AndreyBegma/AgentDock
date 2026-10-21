import { z } from 'zod';
import type { TokenSaverRunKind } from '../token-saver/contracts';

/**
 * #746 D9: a technique's mode in a project — `off` (no card), `ab` (each card
 * drawn into arm A or B) or `on` (every card).
 */
export const TECHNIQUE_MODES = ['off', 'ab', 'on'] as const;
export type TechniqueMode = (typeof TECHNIQUE_MODES)[number];
export const techniqueModeSchema = z.enum(TECHNIQUE_MODES);

/** #746 D9: arm A runs without the technique, arm B with it. */
export const TECHNIQUE_ARMS = ['a', 'b'] as const;
export type TechniqueArm = (typeof TECHNIQUE_ARMS)[number];

/** One saving technique under test (ADR-0074). */
export interface TokenEconomyTechniqueDef {
  /** The flag's name on the launch and in the database, e.g. `read-guard`. */
  key: string;
  label: string;
  /** The mode of a project without a `token_economy_techniques` row. */
  defaultMode: TechniqueMode;
  /** The launches the technique applies to. */
  runKinds: readonly TokenSaverRunKind[];
}

/**
 * #746: the registry of techniques. Empty here — #747, #749, #750 and #751
 * each add their key, in chain order. A key is never reused for another
 * technique: reports read the `runs.techniques` snapshots by it.
 */
export const TOKEN_ECONOMY_TECHNIQUES: readonly TokenEconomyTechniqueDef[] = [
  // #747 D2: the runner's savers. A launch without a key behaves as before
  // #747 (D3): no cuts, the 1,500-line read guard, the terse register on.
  {
    key: 'mcp-cut',
    label: 'Cut large MCP results',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'grep-cut',
    label: 'Cut large Grep results',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'webfetch-cut',
    label: 'Cut large WebFetch results',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'read-guard-400',
    label: 'Read guard at 400 lines, with an outline',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'terse-register',
    label: 'Terse working register',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  // #749 D3, D6: a launch without a key behaves as before #749 (D7): no size
  // rule, and the 1-hour prompt-cache TTL.
  {
    key: 'resume-by-size',
    label: 'Fresh session for a long history',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'cache-ttl-1h',
    label: '1-hour prompt-cache TTL',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  // #750 D3, D8 (ADR-0076): the class → model and effort mapping and the
  // escalation to Opus. Off (arm A) keeps the #322/#663 recommendation; the
  // session lock (D7) holds in both arms.
  {
    key: 'model-by-type',
    label: 'Model and effort by card class, with an escalation to Opus',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  // #751 S1: the launch prefix. Off (arm A) launches the whole prefix as
  // before #751; the measurement (B1) runs in both arms.
  {
    key: 'prefix-select',
    label: 'Rules, skills and MCP servers selected by card type',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'rules-compressed',
    label: 'Approved compressed rules',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
  {
    key: 'prefix-overlays',
    label: 'Approved overlays of CLAUDE.md and project skills',
    defaultMode: 'ab',
    runKinds: ['card'],
  },
];

/** A technique key: lower-case words joined by `-`. */
export const TECHNIQUE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** #746 D2: the share of cards drawn into arm B when nothing is set. */
export const TOKEN_ECONOMY_DEFAULT_B_SHARE = 50;

/** #746: a verdict needs this many settled cards in each arm. */
export const TOKEN_ECONOMY_MIN_CARDS_PER_ARM = 30;

/**
 * #746 D11: the flags a launch carries, `{ [technique]: on }`. Strict over the
 * given keys, so a runner refuses a technique it does not know.
 */
export const techniqueFlagsSchemaOf = (keys: readonly string[]) =>
  z.strictObject(
    Object.fromEntries(keys.map((key) => [key, z.boolean().optional()])),
  );

/** The flags over the registered techniques. */
export const techniqueFlagsSchema = techniqueFlagsSchemaOf(
  TOKEN_ECONOMY_TECHNIQUES.map((t) => t.key),
);
export type TechniqueFlags = Record<string, boolean>;

/**
 * #746 D10: the arm of a card for one technique — a seeded hash of
 * `(cardId, technique)` against the B share, so the draw is reproducible and
 * needs no lock. A share of 0 is always `a`; 100 always `b`.
 */
export const assignArm = (
  cardId: string,
  technique: string,
  bSharePercent: number,
): TechniqueArm =>
  bucketOf(`${cardId}\u0000${technique}`) < bSharePercent ? 'b' : 'a';

/** FNV-1a (32-bit) of a string, mod 100. */
const bucketOf = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
};

/** #746 D9: the arm a card gets at its first launch, given the mode. */
export const armForMode = (
  mode: TechniqueMode,
  cardId: string,
  technique: string,
  bSharePercent: number,
): TechniqueArm =>
  mode === 'on'
    ? 'b'
    : mode === 'off'
      ? 'a'
      : assignArm(cardId, technique, bSharePercent);
