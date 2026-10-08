import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The captured Claude Code 2.1.294 exports (`claude -p`, telemetry on,
 * `OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1`), one run per encoding,
 * scrubbed: the email, organization and account ids are replaced by the
 * placeholders below. The prompt and tool sentinels are left in on purpose.
 */
const FIXTURES = join(import.meta.dir, 'fixtures');

export const fixtureProtobuf = (): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      readFileSync(join(FIXTURES, 'claude-logs.pb.base64'), 'utf8'),
      'base64',
    ),
  );

export const fixtureJson = (): string =>
  readFileSync(join(FIXTURES, 'claude-logs.json'), 'utf8');

/** The transcript of the JSON run's session, `user`/`assistant` lines only. */
export const FIXTURE_TRANSCRIPT = join(FIXTURES, 'claude-transcript.jsonl');

/** Session ids of the two captured runs. */
export const JSON_SESSION = '370042b4-4ba5-4ef6-87c8-7cf3ddba0367';
export const PROTOBUF_SESSION = 'e58f3899-adac-4499-9757-5d24b3cac4e5';

/** What must never leave the runner (D16), as it appears in the fixtures. */
export const FORBIDDEN = [
  'AGENTDOCK_SENTINEL_PROMPT_9c1e',
  'AGENTDOCK_SENTINEL_TOOL_7f3a',
  'person@example.invalid',
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
  'user_fixture_account',
  'fixture-user-id-',
  'Echo sentinel string',
  'Echo the sentinel string',
] as const;
