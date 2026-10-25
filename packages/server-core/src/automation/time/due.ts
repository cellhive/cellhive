/**
 * The due rule moved to the shared time scan core (ADR-34 §1, BACKLOG T546);
 * re-exported here so automation code and the T508 tests keep their imports.
 */
export { dueAt, firstTimeZone, valueRangeOf, type DueRule } from '../../time-scan/due.js';
