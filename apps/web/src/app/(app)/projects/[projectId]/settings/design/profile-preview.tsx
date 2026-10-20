'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { ResizableFrame } from '@andrewbehma/glass-ui/resizable-frame';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
} from '@nautelle/shared';
import { useEffect, useState } from 'react';
import { uiProfilePreviewSrc } from '../../../../../../lib/design/href';

type PreviewState = 'checking' | 'ready' | 'missing' | 'failed';

/** A settings column is about this wide; the frame scrolls on a phone. */
const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 480;

/**
 * The style kit and snippets rendered as one page (spec 223 "UI"), served by
 * the API with the mockup's headers and shown in the same sandbox as a
 * mockup. An iframe cannot tell a 404 from a page, so the page is asked for
 * first: an endpoint that does not answer is a section error, never a frame
 * showing the API's error body.
 */
export function ProfilePreview({
  projectId,
  version,
}: {
  projectId: string;
  version: number;
}) {
  const src = uiProfilePreviewSrc(projectId, version);
  const [state, setState] = useState<PreviewState>('checking');
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(PREVIEW_WIDTH);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    let current = true;
    setState('checking');
    fetch(src, { method: 'HEAD' })
      .then((response) => {
        if (!current) return;
        if (response.ok) setState('ready');
        else setState(response.status === 404 ? 'missing' : 'failed');
      })
      .catch(() => {
        if (current) setState('failed');
      });
    return () => {
      current = false;
    };
  }, [src, attempt]);

  if (state === 'checking') return <Skeleton className="h-64 w-full" />;
  if (state !== 'ready') {
    return (
      <SectionUnavailable
        title="The preview could not be shown"
        stillWorks={
          state === 'missing'
            ? 'This server does not serve profile previews yet. The kit and snippets are below.'
            : 'The kit and snippets are below.'
        }
        action={
          <Button
            variant="glass"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <ResizableFrame
      width={width}
      height={PREVIEW_HEIGHT}
      min={DESIGN_VIEWPORT_MIN_PX}
      max={DESIGN_VIEWPORT_MAX_PX}
      labels={{ resize: 'Resize the preview' }}
      onWidthChange={setWidth}
    >
      <iframe
        src={src}
        title={`Style kit preview, version ${version}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block size-full border-0 bg-white"
      />
    </ResizableFrame>
  );
}
