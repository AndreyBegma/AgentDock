/**
 * One command filter (#445 D2, D5): it recognises a command by its argv and
 * compresses that command's output. A family (`js`, `ops`, `lang`) exports a
 * list of them from `families/<family>/index.ts`.
 *
 * A filter never has to be careful about errors. The engine checks every
 * result: if a line the classifier calls an error, failure, warning or stack
 * frame is missing, or the result is not shorter, or `apply` throws, the agent
 * gets the original output and the command counts as `passedThrough` (D4b).
 */
export interface Filter {
  /** `<family>/<command>`, lower-case: `js/jest`, `ops/git-log`. */
  id: string;
  /** Whether this filter handles the command. `argv[0]` is the bare program name. */
  matches(argv: readonly string[]): boolean;
  /**
   * A dev server or a watch mode of this command, which never ends on its
   * own: the hook leaves it alone (amendment 3). The engine already treats
   * `--watch` and `run dev|start|serve|watch` that way.
   */
  longRunning?(argv: readonly string[]): boolean;
  /**
   * The compressed output, or `null` when the filter cannot classify this
   * output — the agent then gets it unchanged.
   */
  apply(input: FilterInput): string | null;
}

export interface FilterInput {
  argv: readonly string[];
  /** stdout and stderr, interleaved in the order they arrived. */
  output: string;
  exitCode: number;
}
