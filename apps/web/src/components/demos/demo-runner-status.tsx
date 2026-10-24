import { Banner } from '@andrewbehma/glass-ui/banner';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { DemoRunnerView } from '@nautelle/shared';
import { runnerAdvice } from '../../lib/demos/format';

/**
 * The project's runner as a recorder: DemoFlow's version, whether it is ready,
 * and — when it is not — why and what to do. The control plane never reads the
 * repository (ADR-0001), so whether `demoflow.config.json` exists is the
 * runner's to say; the hint below is static.
 */
export function DemoRunnerStatus({ runner }: { runner: DemoRunnerView }) {
  const advice = runnerAdvice(runner);
  const ready = runner.supported && runner.demoflow?.ready === true;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusPill
          status={ready ? 'done' : 'blocked'}
          label={ready ? 'Ready' : 'Not ready'}
        />
        {runner.demoflow ? (
          <span className="text-ink-2">
            DemoFlow <code>{runner.demoflow.version}</code>
          </span>
        ) : null}
      </div>
      {advice ? (
        <Banner tone="warn" title="Recording is not available">
          {advice}
        </Banner>
      ) : null}
      <p className="text-ink-3 text-xs">
        A card is recorded from a scenario in the repository. If the repository
        has no <code>demoflow.config.json</code>, the runner skips the demo and
        says so on the card; add the file (see the DemoFlow guide) to turn
        recording on for this project.
      </p>
    </div>
  );
}
