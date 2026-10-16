import type { Filter } from '../../types';
import {
  cleanLines,
  dropNoise,
  hasFlag,
  joinLines,
  positionals,
  squeezeBlanks,
} from './util';

/**
 * Maven and Gradle. Maven loses its plugin banners, downloads and the
 * `Running <class>` lines; Gradle loses the `> Task` stream and its hints.
 * Test counts, failures, warnings and the build result stay.
 */

const MAVEN_NOISE =
  /^\[INFO\]\s*$|^\[INFO\] (-{5,}|={5,}|Scanning for projects|Building |---|Downloading from|Downloaded from|Copying \d+|Using |Nothing to compile|Changes detected|Compiling \d+|Running |T E S T S|Results:|Reactor Build Order:|Finished at:|Total time:|skip non existing|Argument)|^Progress \(\d+\)|^(Downloading|Downloaded) from /;
const MAVEN_KNOWN = /\[INFO\] Scanning for projects|BUILD (SUCCESS|FAILURE)/;
const MAVEN_SERVING = /(^|:)(run|dev|start|watch|serve|run-forked|java)$/;

const MAVEN_VALUE_FLAGS = ['-f', '-pl', '-P', '-s', '-T', '-rf', '-l', '-D'];

export const mavenFilter: Filter = {
  id: 'lang/maven',
  matches: (argv) => ['mvn', 'mvnw', 'mvnd'].includes(argv[0] ?? ''),
  longRunning: (argv) =>
    positionals(argv, MAVEN_VALUE_FLAGS).some(
      (goal) => goal.includes(':') && MAVEN_SERVING.test(goal),
    ),
  apply: ({ output }) => {
    const lines = cleanLines(output);
    if (!lines.some((l) => MAVEN_KNOWN.test(l))) return null;
    return joinLines(squeezeBlanks(dropNoise(lines, MAVEN_NOISE)));
  },
};

const GRADLE_NOISE =
  /^> (Task |Configure project )\S*.*$|^(Starting a Gradle Daemon|Daemon will be stopped|Download https?:)|^> (Run with --|Get more help at)|^\* Try:$|^(\S.*) > .* (PASSED|SKIPPED)$/;
const GRADLE_KNOWN = /^(BUILD (SUCCESSFUL|FAILED)|> Task )/;
const GRADLE_SERVING =
  /(^|:)(bootRun|bootTestRun|run|quarkusDev|jettyRun|appRun|tomcatRun|watch|serve|dev)$/;

export const gradleFilter: Filter = {
  id: 'lang/gradle',
  matches: (argv) => argv[0] === 'gradle' || argv[0] === 'gradlew',
  longRunning: (argv) =>
    hasFlag(argv, '--continuous', '-t') ||
    positionals(argv).some((task) => GRADLE_SERVING.test(task)),
  apply: ({ output }) => {
    const lines = cleanLines(output);
    if (!lines.some((l) => GRADLE_KNOWN.test(l))) return null;
    return joinLines(squeezeBlanks(dropNoise(lines, GRADLE_NOISE)));
  },
};
