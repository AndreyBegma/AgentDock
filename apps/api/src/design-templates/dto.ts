import type { DesignTemplateFrame } from '@nautelle/shared';
import {
  DESIGN_TEMPLATE_FRAMES_MAX,
  DESIGN_TEMPLATE_NAME_MAX,
  type DesignTemplateUpsertRequest,
} from '@nautelle/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * `PUT /projects/:projectId/design/templates/:key`. The global pipe checks the
 * envelope; `designTemplateSchema` checks the frames (D9), because their
 * rules — unique keys and names, one frame of a kind — span the whole list.
 */
export class DesignTemplateUpsertDto implements DesignTemplateUpsertRequest {
  @IsString()
  @MaxLength(DESIGN_TEMPLATE_NAME_MAX * 2)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DESIGN_TEMPLATE_FRAMES_MAX)
  @IsObject({ each: true })
  frames!: DesignTemplateFrame[];
}
