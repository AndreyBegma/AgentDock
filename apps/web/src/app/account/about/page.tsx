import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { Section } from '@andrewbehma/glass-ui/section';
import { ContactList } from '../../../components/about/contact-links';
import { PageHeader } from '../../../components/page-header/page-header';

/** Set by `next.config.ts` from this app's `package.json`. */
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** C-293: the product, its version and the author's links (S-7 calm layout). */
export default function AboutPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="About"
        description="Self-hosted control plane for Claude Code and Codex agent fleets."
        className="mb-0"
      />
      <Section title="Product">
        <KeyValueList
          items={[
            { key: 'name', label: 'Name', value: 'AgentDock' },
            { key: 'version', label: 'Version', value: VERSION },
          ]}
        />
      </Section>
      <Section
        title="Contacts"
        description="Where to reach the author."
        pad="none"
      >
        <ContactList />
      </Section>
    </div>
  );
}
