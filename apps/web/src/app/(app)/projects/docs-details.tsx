import type { DocsSourceView } from '@agentdock/shared';
import type { DocsSource } from '@agentdock/shared/protocol';
import { Badge } from 'glass-ui/badge';
import { DOCS_KIND_LABEL, DOCS_RULE_LABEL } from '../../../lib/projects/format';

/** What detection and a stored source have in common. */
type DocsLike = Pick<
  DocsSource,
  | 'kind'
  | 'localPath'
  | 'repo'
  | 'isGitRepo'
  | 'detectedBy'
  | 'evidence'
  | 'classified'
  | 'candidates'
> &
  Partial<Pick<DocsSourceView, 'manual'>>;

const CLASSES = [
  ['specs', 'Specs'],
  ['adr', 'Decisions'],
  ['roadmap', 'Roadmap'],
  ['reports', 'Reports'],
] as const;

export function DocsDetails({ docs }: { docs: DocsLike }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-2">Kind</dt>
        <dd>
          {DOCS_KIND_LABEL[docs.kind]}
          {docs.manual ? (
            <Badge className="ml-2" tone="warn" label="manual" />
          ) : null}
        </dd>
        {docs.localPath ? (
          <>
            <dt className="text-ink-2">Path</dt>
            <dd className="font-mono break-all">{docs.localPath}</dd>
          </>
        ) : null}
        {docs.repo ? (
          <>
            <dt className="text-ink-2">Repository</dt>
            <dd>{docs.repo}</dd>
          </>
        ) : null}
        {docs.kind !== 'none' && docs.kind !== 'remote_repo' ? (
          <>
            <dt className="text-ink-2">Git repository</dt>
            <dd>{docs.isGitRepo ? 'yes' : 'no'}</dd>
          </>
        ) : null}
        <dt className="text-ink-2">Found by</dt>
        <dd>
          {docs.detectedBy
            ? DOCS_RULE_LABEL[docs.detectedBy]
            : docs.manual
              ? 'set by an administrator'
              : '—'}
        </dd>
      </dl>

      {docs.evidence.length > 0 ? (
        <section aria-label="Evidence">
          <h4 className="text-ink-2 mb-1 text-xs font-medium">Evidence</h4>
          <ul className="flex flex-col gap-1 font-mono text-xs break-all">
            {docs.evidence.map((item) => (
              <li key={`${item.file ?? item.url ?? ''}:${item.line ?? ''}`}>
                {item.file
                  ? `${item.file}${item.line ? `:${item.line}` : ''}`
                  : null}
                {item.url ?? null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {CLASSES.some(([key]) => docs.classified[key].length > 0) ? (
        <section aria-label="Classification">
          <h4 className="text-ink-2 mb-1 text-xs font-medium">Classified</h4>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {CLASSES.filter(([key]) => docs.classified[key].length > 0).map(
              ([key, label]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="font-mono text-xs break-all">
                    {docs.classified[key].join(', ')}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>
      ) : null}

      {docs.candidates.length > 0 ? (
        <section aria-label="Candidates checked">
          <h4 className="text-ink-2 mb-1 text-xs font-medium">
            Candidates checked
          </h4>
          <ul className="flex flex-col gap-1 text-xs">
            {docs.candidates.map((candidate) => (
              <li
                key={`${candidate.rule}:${candidate.target}`}
                className="flex items-start gap-2"
              >
                <Badge
                  tone={candidate.hit ? 'ok' : 'neutral'}
                  label={candidate.hit ? 'hit' : 'miss'}
                />
                <span>
                  <span className="text-ink-2">
                    {DOCS_RULE_LABEL[candidate.rule]}
                    {' · '}
                  </span>
                  <span className="font-mono break-all">
                    {candidate.target}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
