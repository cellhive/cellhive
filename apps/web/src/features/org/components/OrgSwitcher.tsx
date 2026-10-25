import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { Building2, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { orgPath } from '../hooks';

import type { MeOrganization } from '@cellhive/contracts';

function OrgName({ org }: { org: MeOrganization }) {
  return (
    <>
      <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <span className="truncate font-medium">{org.name}</span>
    </>
  );
}

/** Current organization; a switcher only when the user belongs to more than one. */
export function OrgSwitcher({
  orgs,
  current,
}: {
  orgs: readonly MeOrganization[];
  current: MeOrganization;
}) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  if (orgs.length <= 1) {
    return (
      <div className="flex h-control items-center gap-2 px-2 text-body">
        <OrgName org={current} />
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-2"
          aria-label={t('orgSwitcher.label', { name: current.name })}
        >
          <span className="flex min-w-0 items-center gap-2">
            <OrgName org={current} />
          </span>
          <ChevronsUpDown aria-hidden="true" className="text-fg-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('orgSwitcher.heading')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.id}
          onValueChange={(id) => {
            const org = orgs.find((item) => item.id === id);
            if (org !== undefined) void navigate(orgPath(org));
          }}
        >
          {orgs.map((org) => (
            <DropdownMenuRadioItem key={org.id} value={org.id}>
              <span className="truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
