'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type {
  ProjectRuleAcceptRequest,
  ProjectRuleImportResult,
  ProjectRuleScanResult,
} from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../../../lib/api';
import {
  describeRuleError,
  importSummary,
  initialCandidateSelection,
  selectedCandidates,
  withRuleCount,
} from '../../../../../../lib/project-rules/format';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';
import { RuleCandidateList } from '../../../rule-candidates';

type State =
  | { status: 'scanning' }
  | { status: 'failed'; message: string }
  | { status: 'done'; result: ProjectRuleScanResult }
  | { status: 'added'; result: ProjectRuleImportResult };

/**
 * #584: scans the project's documented conventions again on its runner and
 * adds the checked candidates as rules. Candidates that are already rules
 * are shown but cannot be checked, so a rescan never duplicates a rule.
 */
export function ScanDialog({
  projectId,
  open,
  onClose,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'scanning' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const scan = useCallback(async () => {
    setState({ status: 'scanning' });
    try {
      const result = await api<ProjectRuleScanResult>(
        `/projects/${projectId}/rules/scan`,
        { method: 'POST' },
      );
      setState({ status: 'done', result });
      setSelected(initialCandidateSelection(result.candidates));
    } catch (err) {
      setState({ status: 'failed', message: describeRuleError(err) });
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void scan();
  }, [open, scan]);

  const accepted =
    state.status === 'done'
      ? selectedCandidates(state.result.candidates, selected)
      : [];

  const add = async () => {
    setBusy(true);
    try {
      const result = await api<ProjectRuleImportResult>(
        `/projects/${projectId}/rules/accept`,
        {
          method: 'POST',
          body: { candidates: accepted } satisfies ProjectRuleAcceptRequest,
        },
      );
      setState({ status: 'added', result });
      onAdded();
    } catch (err) {
      showError(describeRuleError(err));
    } finally {
      setBusy(false);
    }
  };

  const body = (() => {
    switch (state.status) {
      case 'scanning':
        return (
          <div role="status" className="flex flex-col gap-2">
            <p className="text-sm text-ink-2">
              Reading CLAUDE.md, AGENTS.md, CONTRIBUTING.md and linter configs…
            </p>
            <Skeleton className="h-24 w-full" />
          </div>
        );
      case 'failed':
        return (
          <p role="alert" className="text-sm text-danger">
            The scan didn't finish: {state.message}
          </p>
        );
      case 'added':
        return state.result.skippedTitles.length > 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-ink-2">
              Skipped — a rule with this name already exists:
            </p>
            <ul className="list-disc pl-5">
              {state.result.skippedTitles.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </div>
        ) : null;
      case 'done': {
        const { candidates, warnings } = state.result;
        return (
          <div className="flex flex-col gap-3">
            {candidates.length === 0 ? (
              <p className="text-sm text-ink-2">
                No coding rules found in this repository's CLAUDE.md, AGENTS.md,
                CONTRIBUTING.md or linter configs.
              </p>
            ) : (
              <RuleCandidateList
                candidates={candidates}
                selected={selected}
                onChange={setSelected}
                disabled={busy}
              />
            )}
            {warnings.length > 0 ? (
              <ul
                aria-label="Skipped files"
                className="flex flex-col gap-1 text-xs text-ink-3"
              >
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      }
    }
  })();

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={
          state.status === 'added' ? 'Rules added' : 'Scan project for rules'
        }
        description={
          state.status === 'added'
            ? importSummary(state.result.created, state.result.skipped)
            : "Rules the repository already documents, read by the project's runner. Nothing is added until you choose; added rules are enabled."
        }
        footer={
          state.status === 'added' ? (
            <Button variant="solid" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              {state.status === 'failed' ? (
                <Button variant="glass" onClick={() => void scan()}>
                  Scan again
                </Button>
              ) : null}
              <Button
                variant="solid"
                disabled={busy || accepted.length === 0}
                onClick={() => void add()}
              >
                {accepted.length > 0
                  ? withRuleCount('Add', accepted.length)
                  : 'Add rules'}
              </Button>
            </>
          )
        }
      >
        {body}
      </DialogContent>
    </DialogRoot>
  );
}
