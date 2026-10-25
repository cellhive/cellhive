import { data } from 'react-router';

/**
 * Shows the 404 screen through the nearest route error boundary. Used for
 * "does not exist" and "no access" alike (FRONTEND §2, CONTRACTS §6).
 */
export function notFound(): never {
  throw data(null, { status: 404 });
}
