import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { isSystemRole } from './model';

import type { RoleDto } from '@cellhive/contracts';

/**
 * The name the UI shows for a role: system roles by their translated label
 * (stored as "Admin", "Editor", "Reader"), custom roles by their own name.
 */
export function useRoleName(): (role: Pick<RoleDto, 'kind' | 'name'>) => string {
  const { t } = useTranslation('baseSettings');
  return useCallback(
    (role) => (isSystemRole(role) ? t(`roles.system.${role.kind}.name`) : role.name),
    [t],
  );
}
