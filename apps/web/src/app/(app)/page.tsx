import { Card } from 'glass-ui/card';
import { EmptyState } from 'glass-ui/empty-state';

const SECTIONS = [
  { title: 'Fleet', issue: '#11', text: 'Running slots and runner health' },
  { title: 'Blocked on you', issue: '#11', text: 'Slots waiting for a person' },
  {
    title: 'Cost today',
    issue: '#13',
    text: 'Spend and tokens across projects',
  },
];

export default function OverviewPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold">Overview</h1>
      <div className="grid gap-6 md:grid-cols-3">
        {SECTIONS.map((section) => (
          <Card key={section.title} pad="lg" className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">{section.title}</h2>
            <EmptyState
              title="Nothing here yet"
              description={`${section.text} arrive with ${section.issue}.`}
            />
          </Card>
        ))}
      </div>
    </div>
  );
}
