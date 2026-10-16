import type { Filter } from '../../types';
import { cleanLines, dropNoise, joinLines, squeezeBlanks } from './util';

/**
 * phpunit and composer. phpunit drops its progress rows and, under
 * --testdox, the passing tests; composer drops the per-package lines.
 */

const PHPUNIT_NOISE =
  /^[.FEWSIRD]+\s+\d+ \/ \d+ \(\s*\d+%\)$|^\s*✔ |^Test '.*' (started|ended)$|^(Runtime|Configuration):\s|^Time: \d\d:\d\d/;

export const phpunitFilter: Filter = {
  id: 'lang/phpunit',
  matches: (argv) => argv[0] === 'phpunit',
  apply: ({ output }) => {
    const lines = cleanLines(output);
    const known =
      lines.some((l) => /^PHPUnit \d/.test(l)) &&
      lines.some((l) =>
        /^(OK( \(|, but)|Tests: \d+|FAILURES!|ERRORS!|No tests executed)/.test(
          l,
        ),
      );
    if (!known) return null;
    return joinLines(squeezeBlanks(dropNoise(lines, PHPUNIT_NOISE)));
  },
};

const COMPOSER_NOISE =
  /^\s+- (Downloading|Installing|Upgrading|Downgrading|Removing|Locking|Updating|Syncing|Extracting)\s|^\s+\d+\/\d+ \[[=>\-▓░ ]*\]\s+\d+%|^(Loading composer repositories|Resolving dependencies through SAT)/;

export const composerFilter: Filter = {
  id: 'lang/composer',
  matches: (argv) =>
    argv[0] === 'composer' &&
    ['install', 'update', 'require', 'remove'].includes(
      argv.slice(1).find((a) => !a.startsWith('-')) ?? '',
    ),
  apply: ({ output }) => {
    const lines = cleanLines(output);
    const known = lines.some((l) =>
      /^(Installing dependencies|Package operations:|Lock file operations:|Generating autoload files|Nothing to install|Updating dependencies)/.test(
        l,
      ),
    );
    if (!known) return null;
    return joinLines(squeezeBlanks(dropNoise(lines, COMPOSER_NOISE)));
  },
};
