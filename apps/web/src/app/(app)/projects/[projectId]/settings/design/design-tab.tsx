'use client';

import { Separator } from '@andrewbehma/glass-ui/separator';
import { DesignSettingsSection } from './design-settings-section';
import { ProfileSection } from './profile-section';
import { TemplatesSection } from './templates-section';

/**
 * Project settings → Design (spec 223 "UI", D11–D15, D17): the UI profile
 * every mockup is styled from, the viewer's viewport presets, and the
 * default design skills. The profile is project-wide: every member reads it,
 * an operator rebuilds it, a project admin edits it and the settings.
 */
export function DesignTab({
  projectId,
  isAdmin,
  canOperate,
}: {
  projectId: string;
  isAdmin: boolean;
  canOperate: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <ProfileSection
        projectId={projectId}
        isAdmin={isAdmin}
        canOperate={canOperate}
      />
      <Separator />
      <DesignSettingsSection projectId={projectId} isAdmin={isAdmin} />
      <Separator />
      <TemplatesSection projectId={projectId} isAdmin={isAdmin} />
    </div>
  );
}
