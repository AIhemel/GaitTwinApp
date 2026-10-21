// Shared by Labels.ts (writes) and the health engine (reads back after a restart); kept separate so
// the two don't import each other.
export const LABELS_FILE = 'labels.csv';
export const LABELS_HEADER = 'utc_ms,label,note';
