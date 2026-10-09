import {
  type ApproveUserRequest,
  type RegistrationState,
  ROLES,
  type Role,
  type UpdateUserRequest,
  USER_STATUSES,
  type UserStatus,
} from '@agentdock/shared';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class ListUsersQuery {
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;
}

export class ApproveUserDto implements ApproveUserRequest {
  @IsIn(ROLES)
  role!: Role;
}

export class UpdateUserDto implements UpdateUserRequest {
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';
}

export class RegistrationStateDto implements RegistrationState {
  @IsBoolean()
  open!: boolean;
}
