import { Card } from 'glass-ui/card';
import type { ReactNode } from 'react';

/** Centered card shared by the unauthenticated pages, which have no shell. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main id="main-content" className="mx-auto w-full max-w-4xl p-6">
      <div className="mx-auto mt-[12vh] w-full max-w-sm">
        <Card pad="lg" className="flex flex-col gap-5">
          <div>
            <h1 className="text-xl font-bold">{title}</h1>
            {description ? (
              <p className="mt-1 text-sm text-ink-2">{description}</p>
            ) : null}
          </div>
          {children}
        </Card>
      </div>
    </main>
  );
}
