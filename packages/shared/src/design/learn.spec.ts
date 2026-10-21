import { describe, expect, it } from 'bun:test';
import {
  commands,
  RUNNER_FEATURE_COMMANDS,
  uiProfileLearnArgsSchema,
  uiProfileLearnResultSchema,
  uiprofileCommands,
} from '../protocol';
import {
  parseUiProfileLearnOutput,
  UI_PROFILE_LEARN_OUTPUT_CONTRACT,
  UI_PROFILE_SCREEN_SUMMARY_MAX,
  UI_PROFILE_STYLE_RULE_MAX,
  UI_PROFILE_STYLE_RULES_MAX,
  uiProfileScreenSchema,
  uiProfileStyleRuleSchema,
} from './index';

const answer = {
  screen: {
    name: 'Billing settings',
    summary: 'Two-column form; summary card on the right.',
    snippetsUsed: ['button', 'card'],
  },
  styleRules: [
    { text: 'Primary actions sit bottom-right.', commentIds: ['c1'] },
  ],
  newSnippets: [{ name: 'plan-card', html: '<div class="card">Plan</div>' }],
};

describe('parseUiProfileLearnOutput (#752 A2)', () => {
  it('accepts the strict JSON object', () => {
    const parsed = parseUiProfileLearnOutput(JSON.stringify(answer));
    expect(parsed).toEqual({ ok: true, output: answer });
  });

  it('accepts the object wrapped in one code fence', () => {
    const parsed = parseUiProfileLearnOutput(
      `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
    );
    expect(parsed.ok).toBe(true);
  });

  it('refuses prose, unknown keys and caps', () => {
    for (const text of [
      'Here is the result: {}',
      JSON.stringify({ ...answer, extra: 1 }),
      JSON.stringify({ ...answer, screen: { ...answer.screen, x: 1 } }),
      JSON.stringify({
        ...answer,
        screen: {
          ...answer.screen,
          summary: 'x'.repeat(UI_PROFILE_SCREEN_SUMMARY_MAX + 1),
        },
      }),
      JSON.stringify({
        ...answer,
        styleRules: [
          { text: 'x'.repeat(UI_PROFILE_STYLE_RULE_MAX + 1), commentIds: [] },
        ],
      }),
      JSON.stringify({
        ...answer,
        styleRules: Array.from(
          { length: UI_PROFILE_STYLE_RULES_MAX + 1 },
          () => ({ text: 'r', commentIds: [] }),
        ),
      }),
    ]) {
      expect(parseUiProfileLearnOutput(text).ok).toBe(false);
    }
  });

  it('names the caps in the contract the model reads', () => {
    expect(UI_PROFILE_LEARN_OUTPUT_CONTRACT).toContain(
      String(UI_PROFILE_SCREEN_SUMMARY_MAX),
    );
    expect(UI_PROFILE_LEARN_OUTPUT_CONTRACT).toContain('"newSnippets"');
  });
});

describe('uiprofile.learn (#752 A2)', () => {
  const learn = {
    runId: 'cmrun0002',
    projectId: 'prj_1',
    sessionId: '0b8f8c7e-6f4e-4a8a-9f3e-1c2d3e4f5a6b',
    prompt: '# Learn\n\nThe approved design.',
    profileKey: 'blacktoorroot',
    model: 'sonnet',
    timeoutSec: 180,
  };

  it('is in the allowlist, needs an operator, and is its own feature', () => {
    expect(Object.hasOwn(commands, 'uiprofile.learn')).toBe(true);
    expect(uiprofileCommands['uiprofile.learn'].minRole).toBe('operator');
    expect(RUNNER_FEATURE_COMMANDS.uiProfileLearn).toEqual(['uiprofile.learn']);
    // An older runner still designs: learning is not a design command.
    expect(RUNNER_FEATURE_COMMANDS.design).not.toContain('uiprofile.learn');
  });

  it('takes sonnet only, a session id and a non-empty prompt', () => {
    expect(uiProfileLearnArgsSchema.safeParse(learn).success).toBe(true);
    for (const bad of [
      { ...learn, model: 'opus' },
      { ...learn, sessionId: 'nope' },
      { ...learn, prompt: ' ' },
      { ...learn, prompt: 'a\u0000b' },
      { ...learn, timeoutSec: 5 },
      { ...learn, root: '/home/dev/repo' },
    ]) {
      expect(uiProfileLearnArgsSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('answers the text and whether it was cut', () => {
    expect(
      uiProfileLearnResultSchema.safeParse({
        resultText: '{}',
        resultTruncated: false,
      }).success,
    ).toBe(true);
    expect(
      uiProfileLearnResultSchema.safeParse({ resultText: '{}' }).success,
    ).toBe(false);
  });
});

describe('profile memory schemas (#752 A3)', () => {
  it('a library entry carries its design, revision and approval time', () => {
    expect(
      uiProfileScreenSchema.safeParse({
        designId: 'd1',
        revisionId: 'r1',
        name: 'Billing',
        summary: 'A form.',
        snippetsUsed: [],
        approvedAt: '2026-10-21T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it("a style rule is a person's when it has no design", () => {
    expect(
      uiProfileStyleRuleSchema.safeParse({
        text: 'Use sentence case.',
        commentIds: [],
        designId: null,
      }).success,
    ).toBe(true);
    expect(
      uiProfileStyleRuleSchema.safeParse({
        text: '',
        commentIds: [],
        designId: null,
      }).success,
    ).toBe(false);
  });
});
