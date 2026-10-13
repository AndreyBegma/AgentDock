import type { Metadata } from 'next';
import { InstallGuide } from './install-guide';

export const metadata: Metadata = {
  title: 'Install the runner · AgentDock',
  description:
    'How to install the AgentDock runner, pair it with this server and keep it online.',
};

/** Public (issue #145): the proxy lets `/install` through without a session. */
export default function InstallPage() {
  return <InstallGuide />;
}
