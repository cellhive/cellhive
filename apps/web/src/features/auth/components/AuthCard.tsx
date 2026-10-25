import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@cellhive/ui';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';

import type { ReactNode } from 'react';

/** Card of the auth screens; its title is also the page title. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
