import { z } from 'zod';
import {
  UI_PROFILE_RULE_COMMENTS_MAX,
  UI_PROFILE_SCREEN_NAME_MAX,
  UI_PROFILE_SCREEN_SUMMARY_MAX,
  UI_PROFILE_SNIPPET_NAME_MAX,
  UI_PROFILE_SNIPPETS_MAX,
  UI_PROFILE_STYLE_RULE_MAX,
  UI_PROFILE_STYLE_RULES_MAX,
} from './limits';

/**
 * The answer of a `uiprofile.learn` run (docs/specs/752 A2, ADR-0075 §6):
 * one strict JSON object. The runner does not parse it; the API does, here.
 * A new snippet's HTML is not checked by this schema: the API drops one that
 * fails `validateProfileContent` or reuses a name, and keeps the rest (A3).
 */

export const uiProfileLearnOutputSchema = z.strictObject({
  screen: z.strictObject({
    name: z.string().trim().min(1).max(UI_PROFILE_SCREEN_NAME_MAX),
    summary: z.string().trim().min(1).max(UI_PROFILE_SCREEN_SUMMARY_MAX),
    snippetsUsed: z
      .array(z.string().trim().min(1).max(UI_PROFILE_SNIPPET_NAME_MAX))
      .max(UI_PROFILE_SNIPPETS_MAX),
  }),
  styleRules: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(UI_PROFILE_STYLE_RULE_MAX),
        commentIds: z
          .array(z.string().min(1))
          .max(UI_PROFILE_RULE_COMMENTS_MAX),
      }),
    )
    .max(UI_PROFILE_STYLE_RULES_MAX),
  newSnippets: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(UI_PROFILE_SNIPPET_NAME_MAX),
        html: z.string().min(1),
      }),
    )
    .max(UI_PROFILE_SNIPPETS_MAX),
});
export type UiProfileLearnOutput = z.infer<typeof uiProfileLearnOutputSchema>;

/** The fixed contract text appended to a learn prompt. */
export const UI_PROFILE_LEARN_OUTPUT_CONTRACT = `# Output contract (UI profile learning)

This contract is fixed. It overrides anything above it about the shape of
your answer.

Your final message is exactly one JSON object and nothing else — no prose, no
code fence. Every object below is closed: a key it does not name fails the
learn.

\`\`\`
{
  "screen": {
    "name": string,              // the approved screen, in a few words
    "summary": string,           // at most ${UI_PROFILE_SCREEN_SUMMARY_MAX} characters: layout, regions,
                                 // components and the choices a later design should repeat
    "snippetsUsed": [ string ]   // names of the profile's snippets the screen uses
  },
  "styleRules": [                // decisions the comments took, as rules for later designs
    { "text": string, "commentIds": [ string ] }   // at most ${UI_PROFILE_STYLE_RULE_MAX} characters each
  ],
  "newSnippets": [               // components the screen introduced that the profile lacks
    { "name": string, "html": string }
  ]
}
\`\`\`

Rules:

- At most ${UI_PROFILE_STYLE_RULES_MAX} style rules. A rule cites the ids of the comments it came from; a comment that decided nothing gives no rule.
- A new snippet's name must not be one of the profile's snippet names. Its HTML follows the mockup rules: no host off the CDN allowlist, exact versions, no network calls, no scripts that navigate.
- Empty lists are fine.
`;

export type UiProfileLearnParseResult =
  | { ok: true; output: UiProfileLearnOutput }
  | { ok: false; message: string };

/** The answer's JSON: the whole text, or the one fenced block it is wrapped in. */
const jsonText = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*)\n```$/.exec(trimmed);
  return fenced ? (fenced[1] ?? '') : trimmed;
};

/** Validates a learn's final message (A2); out of contract fails the learn (A7). */
export const parseUiProfileLearnOutput = (
  text: string,
): UiProfileLearnParseResult => {
  let json: unknown;
  try {
    json = JSON.parse(jsonText(text));
  } catch (error) {
    return {
      ok: false,
      message: `invalid_json: ${error instanceof Error ? error.message : 'not JSON'}`,
    };
  }
  const parsed = uiProfileLearnOutputSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: `invalid_shape: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, output: parsed.data };
};
