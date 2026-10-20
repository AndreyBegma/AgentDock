/**
 * #663 D2, D3 (ADR-0068, amends ADR-0039 §4): the one terse register. It is
 * printed by `nautelle-runner register`, embedded in the card worker prompt,
 * and used by the plugin whenever the runner is installed. Change the text
 * here and nowhere else; a test pins the card worker prompt to it.
 */

/** What stays in complete prose, whatever the working register says. */
export const REGISTER_FULL_PROSE_EXEMPTIONS = [
  'PR descriptions',
  'specs',
  'ADRs',
  'docs',
  'commits',
  'code comments',
  'questions to the person',
  '`finish_card` summaries',
  'design files',
  'Planner messages',
] as const;

/**
 * The register as lines: terse for what only the agent reads in the terminal,
 * complete for everything a person or a file keeps.
 */
export const TERSE_REGISTER_LINES: readonly string[] = [
  '- Terminal text only you read: caveman. Fragments, no articles, no preamble, no restating. Results and decisions only.',
  `- Full sentences, every required section: ${REGISTER_FULL_PROSE_EXEMPTIONS.join(', ')}.`,
];

/** The register as printed by `nautelle-runner register`. */
export const TERSE_REGISTER = TERSE_REGISTER_LINES.join('\n');
