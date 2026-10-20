import { Script } from 'node:vm';
import type {
  DesignFrameDraft,
  PlannerParseResult,
  PlanTurnAction,
} from '@agentdock/shared';

/**
 * #690, spec 223 D6: every inline script of a drawn frame must run in the
 * mockup iframe. A script that does not parse, or that declares a top-level
 * `const`/`let`/`class` the window already holds (`const top` beside the
 * read-only `window.top`), is refused by the browser whole — the frame
 * renders empty and nothing else notices. The check compiles each script
 * with `node:vm` and never runs it; a runtime error stays out of scope.
 */

/** Window globals a top-level lexical declaration must not shadow. */
export const MOCKUP_RESERVED_GLOBALS = [
  'top',
  'window',
  'self',
  'parent',
  'frames',
  'location',
  'document',
  'name',
  'status',
  'length',
  'opener',
  'closed',
] as const;

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const attrOf = (attrs: string, name: string): string | undefined => {
  const m = attrs.match(
    new RegExp(
      `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`,
      'i',
    ),
  );
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined;
};

/** A body the browser runs as a classic script: no `src`, a JavaScript type. */
const isClassic = (attrs: string): boolean => {
  if (attrOf(attrs, 'src') !== undefined) return false;
  const type = attrOf(attrs, 'type')?.trim().toLowerCase();
  return (
    type === undefined ||
    type === '' ||
    /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type)
  );
};

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/** The compiler's message, with the script's line when the stack names one. */
const compileError = (code: string): string | null => {
  try {
    new Script(code, { filename: 'mockup-script' });
    return null;
  } catch (error) {
    // Not `instanceof Error`: the compiler's realm may not be the caller's.
    const { name, message, stack } = error as Partial<Error>;
    const line = stack?.match(/^mockup-script:(\d+)/m)?.[1];
    return `${name ?? 'SyntaxError'}: ${message ?? String(error)}${line ? ` (line ${line})` : ''}`;
  }
};

/**
 * The first broken inline script of one frame's HTML, as a message for the
 * planner; `null` when every script would run.
 */
export const checkMockupScripts = (html: string): string | null => {
  let index = 0;
  for (const match of html.matchAll(SCRIPT)) {
    if (!isClassic(match[1] ?? '')) continue;
    index += 1;
    const code = match[2] ?? '';
    const which = `the ${ordinal(index)} inline script`;
    const syntax = compileError(code);
    if (syntax) {
      return `${which} does not parse: "${syntax}"`;
    }
    // A top-level lexical name clashes with a top-level `var` of the same
    // name; one nested in a block or a function does not.
    const clash = compileError(
      `${code}\n;var ${MOCKUP_RESERVED_GLOBALS.join(', ')};`,
    );
    if (clash) {
      const name = clash.match(/Identifier '([^']+)'/)?.[1];
      return `${which} declares a top-level "${name ?? '?'}", which the window already holds — the browser throws "SyntaxError: Identifier '${name ?? '?'}' has already been declared" and runs none of it; wrap the script in an IIFE`;
    }
  }
  return null;
};

/**
 * Applies `checkMockupScripts` to a parsed design turn's drawn frames — not
 * to the ones `kept` copies from the previous revision, which were checked
 * when drawn. Any other result passes through.
 */
export const withMockupScriptCheck = <A extends PlanTurnAction>(
  parsed: PlannerParseResult<A>,
): PlannerParseResult<A> => {
  if (!parsed.ok || !('frames' in parsed)) return parsed;
  const { kept } = parsed.output as { kept?: readonly string[] };
  const keptKeys = new Set((kept ?? []).map((n) => n.toLowerCase()));
  for (const frame of parsed.frames as DesignFrameDraft[]) {
    if (keptKeys.has(frame.name.toLowerCase())) continue;
    const problem = checkMockupScripts(frame.html);
    if (problem) {
      return {
        ok: false,
        error: {
          code: 'contract_violation',
          reason: 'design_script_invalid',
          message: `frame "${frame.name}": ${problem}`,
        },
      };
    }
  }
  return parsed;
};
