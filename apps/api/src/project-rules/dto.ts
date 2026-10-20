import {
  PROJECT_RULE_ACCEPT_MAX,
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_IMPORT_MAX,
  PROJECT_RULE_SOURCE_MAX,
  PROJECT_RULE_TITLE_MAX,
  type ProjectRuleAcceptRequest,
  type ProjectRuleCandidateInput,
  type ProjectRuleCreateRequest,
  type ProjectRuleImportRequest,
  type ProjectRuleReorderRequest,
  type ProjectRuleUpdateRequest,
} from '@nautelle/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** A project has far fewer rules; the cap only bounds the request. */
const REORDER_MAX = 1000;
const ID_MAX_LENGTH = 64;

/** Surrounding whitespace never counts: `'  '` is an empty title. */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `POST /projects/:id/rules`. */
export class ProjectRuleCreateDto implements ProjectRuleCreateRequest {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(PROJECT_RULE_TITLE_MAX)
  title!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(PROJECT_RULE_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `PATCH /projects/:id/rules/:ruleId` — only the fields given change. */
export class ProjectRuleUpdateDto implements ProjectRuleUpdateRequest {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(PROJECT_RULE_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(PROJECT_RULE_DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `PUT /projects/:id/rules/order`. */
export class ProjectRuleReorderDto implements ProjectRuleReorderRequest {
  @IsArray()
  @ArrayMaxSize(REORDER_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(ID_MAX_LENGTH, { each: true })
  ruleIds!: string[];
}

/** `POST /projects/:id/rules/import`. */
export class ProjectRuleImportDto implements ProjectRuleImportRequest {
  @IsString()
  @MaxLength(PROJECT_RULE_IMPORT_MAX)
  markdown!: string;
}

/** One accepted scan candidate (#584). */
export class ProjectRuleCandidateDto implements ProjectRuleCandidateInput {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(PROJECT_RULE_TITLE_MAX)
  title!: string;

  @IsString()
  @Transform(trim)
  @MaxLength(PROJECT_RULE_DESCRIPTION_MAX)
  description!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_RULE_SOURCE_MAX)
  source!: string;
}

/** `POST /projects/:id/rules/accept`. */
export class ProjectRuleAcceptDto implements ProjectRuleAcceptRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PROJECT_RULE_ACCEPT_MAX)
  @ValidateNested({ each: true })
  @Type(() => ProjectRuleCandidateDto)
  candidates!: ProjectRuleCandidateDto[];
}
