'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SearchField } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import type {
  ProjectRuleCreateRequest,
  ProjectRuleUpdateRequest,
  ProjectRuleView,
} from '@nautelle/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../../../../lib/api';
import {
  describeRuleError,
  filterRules,
  moveRule,
  type RuleFilter,
  SOURCE_LABEL,
  workerPromptBlock,
} from '../../../../../../lib/project-rules/format';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';
import { ImportDialog } from './import-dialog';
import { type RuleDraft, RuleSheet } from './rule-sheet';
import { ScanDialog } from './scan-dialog';

const FILTERS: readonly { id: RuleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'enabled', label: 'Enabled' },
  { id: 'disabled', label: 'Disabled' },
];

/** The sheet's subject: a new rule, or an existing one. */
type Editing = { rule?: ProjectRuleView } | undefined;

export function RulesTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [rules, setRules] = useState<ProjectRuleView[]>();
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RuleFilter>('all');
  const [editing, setEditing] = useState<Editing>();
  const [deleting, setDeleting] = useState<ProjectRuleView>();
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      setRules(await api<ProjectRuleView[]>(`/projects/${projectId}/rules`));
      setFailed(false);
    } catch (err) {
      setFailed(true);
      showError(describeRuleError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  /** Runs a write; whatever happens, the list is re-read so it shows the truth. */
  const run = async (task: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await task();
      return true;
    } catch (err) {
      showError(describeRuleError(err));
      return false;
    } finally {
      await load();
      setBusy(false);
    }
  };

  const patch = (rule: ProjectRuleView, body: ProjectRuleUpdateRequest) =>
    run(() =>
      api(`/projects/${projectId}/rules/${rule.id}`, { method: 'PATCH', body }),
    );

  const toggle = (rule: ProjectRuleView, enabled: boolean) => {
    // Flip at once; the reload that follows the write settles the truth.
    setRules((current) =>
      current?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
    );
    return patch(rule, { enabled });
  };

  const save = async (draft: RuleDraft) => {
    const rule = editing?.rule;
    const ok = rule
      ? await patch(rule, draft)
      : await run(() =>
          api(`/projects/${projectId}/rules`, {
            method: 'POST',
            body: draft satisfies ProjectRuleCreateRequest,
          }),
        );
    if (ok) setEditing(undefined);
  };

  const remove = async () => {
    if (!deleting) return;
    const rule = deleting;
    const ok = await run(() =>
      api(`/projects/${projectId}/rules/${rule.id}`, { method: 'DELETE' }),
    );
    if (ok) {
      setDeleting(undefined);
      setEditing(undefined);
    }
  };

  const move = (index: number, direction: -1 | 1) => {
    if (!rules) return;
    const next = moveRule(rules, index, direction);
    setRules(next);
    void run(() =>
      api(`/projects/${projectId}/rules/order`, {
        method: 'PUT',
        body: { ruleIds: next.map((r) => r.id) },
      }),
    );
  };

  // Moving a rule inside a filtered view has no clear meaning: reorder shows
  // only on the whole list.
  const whole = search.trim() === '' && filter === 'all';
  const visible = useMemo(
    () => filterRules(rules ?? [], search, filter),
    [rules, search, filter],
  );
  const enabledCount = (rules ?? []).filter((r) => r.enabled).length;

  const columns = (() => {
    const cols: Column<ProjectRuleView>[] = [];
    if (isAdmin && whole) {
      cols.push({
        id: 'order',
        header: <span className="sr-only">Order</span>,
        width: '5.5rem',
        cell: (rule) => {
          const index = (rules ?? []).findIndex((r) => r.id === rule.id);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the controls inside take the keys; this only keeps them from activating the row
            <span
              className="flex gap-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label={`Move ${rule.title} up`}
                disabled={busy || index <= 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label={`Move ${rule.title} down`}
                disabled={busy || index >= (rules ?? []).length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </Button>
            </span>
          );
        },
      });
    }
    cols.push(
      {
        id: 'enabled',
        header: 'Enabled',
        width: '5rem',
        cell: (rule) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: the controls inside take the keys; this only keeps them from activating the row
          <span
            className={isAdmin ? undefined : 'opacity-60'}
            inert={!isAdmin || undefined}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span id={`rule-label-${rule.id}`} className="sr-only">
              Enable: {rule.title}
            </span>
            <Toggle
              labelledBy={`rule-label-${rule.id}`}
              checked={rule.enabled}
              onChange={(enabled) => void toggle(rule, enabled)}
            />
          </span>
        ),
      },
      {
        id: 'rule',
        header: 'Rule',
        cell: (rule) => (
          <span className={rule.enabled ? undefined : 'text-ink-2'}>
            <span className="block font-medium">{rule.title}</span>
            {rule.description ? (
              <span className="line-clamp-2 block text-xs text-ink-2">
                {rule.description}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        cell: (rule) => <Badge label={SOURCE_LABEL[rule.source]} />,
      },
      {
        id: 'updated',
        header: 'Updated',
        align: 'end',
        cell: (rule) => new Date(rule.updatedAt).toLocaleDateString(),
      },
    );
    return cols;
  })();

  if (failed && !rules) {
    return (
      <SectionUnavailable
        title="Coding rules are unavailable"
        detail="The rules could not be loaded."
        action={
          <Button variant="glass" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!rules) return <Skeleton className="h-64 w-full" />;

  const prompt = workerPromptBlock(rules);
  const emptyState =
    rules.length === 0 ? (
      <EmptyState
        title="No coding rules yet"
        description="Add the conventions agents must follow on this project, scan the ones its CLAUDE.md, AGENTS.md and linter configs already state, or import them from a Markdown file."
        action={
          isAdmin ? (
            <div className="flex gap-2">
              <Button variant="glass" onClick={() => setScanning(true)}>
                Scan project
              </Button>
              <Button variant="glass" onClick={() => setImporting(true)}>
                Import Markdown
              </Button>
              <Button variant="solid" onClick={() => setEditing({})}>
                Add rule
              </Button>
            </div>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        title="No rules match"
        description="Change the search or the filter."
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Coding rules"
        description="Every enabled rule goes into the prompt of each agent that works on this project. Use the arrows to change the order."
        actions={
          <span className="text-sm text-ink-2">
            <b className="text-ink">{rules.length}</b> rules ·{' '}
            <b className="text-ink">{enabledCount}</b> enabled
          </span>
        }
      />

      {rules.length > 0 ? (
        <Toolbar
          aria-label="Rules"
          filters={
            <>
              <SearchField
                aria-label="Search rules"
                placeholder="Search rules"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <SegmentedControl role="group" aria-label="Show">
                {FILTERS.map(({ id, label }) => (
                  <SegmentedControlItem
                    key={id}
                    active={filter === id}
                    layoutId="rules-filter"
                  >
                    <button
                      type="button"
                      aria-pressed={filter === id}
                      className="w-full min-w-16 px-3 py-1.5 text-sm whitespace-nowrap"
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </>
          }
          actions={
            isAdmin ? (
              <>
                <Button variant="glass" onClick={() => setScanning(true)}>
                  Scan project
                </Button>
                <Button variant="glass" onClick={() => setImporting(true)}>
                  Import Markdown
                </Button>
                <Button variant="solid" onClick={() => setEditing({})}>
                  Add rule
                </Button>
              </>
            ) : undefined
          }
        />
      ) : null}

      <DataTable
        rows={visible}
        getRowId={(rule) => rule.id}
        columns={columns}
        onRowActivate={(rule) => setEditing({ rule })}
        emptyState={emptyState}
      />

      {rules.length > 0 ? (
        <Disclosure
          open={showPrompt}
          onOpenChange={setShowPrompt}
          trigger="What the worker sees"
        >
          <div className="flex flex-col gap-2">
            <p className="text-xs text-ink-3">
              Enabled rules only, in this order. Changes apply to the next agent
              run; agents already running keep the prompt they started with.
            </p>
            <CodeBlock
              code={prompt || 'No rule is enabled; the prompt carries none.'}
              maxHeight={320}
              wrap
            />
          </div>
        </Disclosure>
      ) : null}

      <RuleSheet
        open={editing !== undefined}
        rule={editing?.rule}
        readOnly={!isAdmin}
        busy={busy}
        onClose={() => setEditing(undefined)}
        onSave={(draft) => void save(draft)}
        onDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={`Delete “${deleting?.title ?? 'this rule'}”?`}
        consequence="Agents stop receiving it from their next run. To pause a rule instead, switch it off."
        verb="Delete rule"
        tone="danger"
        busy={busy}
        onConfirm={() => void remove()}
      />

      {isAdmin ? (
        <ScanDialog
          projectId={projectId}
          open={scanning}
          onClose={() => setScanning(false)}
          onAdded={() => void load()}
        />
      ) : null}

      {isAdmin ? (
        <ImportDialog
          projectId={projectId}
          open={importing}
          onClose={() => setImporting(false)}
          onImported={() => void load()}
        />
      ) : null}
    </div>
  );
}
