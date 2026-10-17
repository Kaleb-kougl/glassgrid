import type { ReactNode } from 'react';

export interface StatProps {
  label: string;
  value: ReactNode;
  /** Forwarded as `data-testid` on the value element for E2E selectors. */
  testId?: string;
}

export function Stat({ label, value, testId }: StatProps) {
  return (
    <div className="gg-stat">
      <dt className="gg-stat__label">{label}</dt>
      <dd className="gg-stat__value" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
