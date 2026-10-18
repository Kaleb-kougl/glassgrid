import type { FilterValue as CoreFilterValue } from '@glassgrid/core';

/** A grid cell as displayed: text, or null for SQL NULL. */
export type GridCellValue = string | null;
export type FilterValue = CoreFilterValue;
