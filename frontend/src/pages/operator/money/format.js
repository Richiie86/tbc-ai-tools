/**
 * Shared formatting utilities for the Money tab and its sub-components.
 */
export const fmt = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n ?? 0);
