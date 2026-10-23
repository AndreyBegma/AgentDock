import { describe, expect, test } from 'bun:test';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { RUNNER_CHANGELOG_URL } from '../../lib/runners/update';
import { RunnerUpdateNotice } from './runner-update-notice';

type Props = {
  children?: ReactNode;
  title?: ReactNode;
  code?: string;
  href?: string;
  onDismiss?: () => void;
};

/** Every element in the tree the notice returns, depth first. */
const elements = (node: ReactNode): ReactElement<Props>[] =>
  Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child)
      ? [child, ...elements(child.props.children)]
      : [],
  );

const notice = {
  latest: '0.15.0',
  lines: ['Your runner desk is on 0.14.0 — 0.15.0 is out.'],
};

describe('RunnerUpdateNotice (C-328)', () => {
  test('says which runner is behind, and the dismissal is the caller’s', () => {
    let dismissed = 0;
    const banner = RunnerUpdateNotice({
      notice,
      onDismiss: () => {
        dismissed += 1;
      },
    });
    expect(banner.props.title).toBe(
      'Your runner desk is on 0.14.0 — 0.15.0 is out.',
    );
    banner.props.onDismiss?.();
    expect(dismissed).toBe(1);
  });

  test('offers the pinned install, the restart and the changelog', () => {
    const tree = elements(RunnerUpdateNotice({ notice, onDismiss: () => {} }));
    const codes = tree
      .filter((element) => element.type === CodeBlock)
      .map((element) => element.props.code);
    expect(codes[0]).toBe('npm i -g nautelle-runner@0.15.0');
    expect(codes).toContain('systemctl --user restart nautelle-runner');
    expect(
      tree.some((element) => element.props.href === RUNNER_CHANGELOG_URL),
    ).toBe(true);
  });
});
