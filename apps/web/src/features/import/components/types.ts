/** Where an import goes (CONTRACTS §19): a new table, or the records of an existing one. */
export type ImportTarget =
  | { readonly mode: 'create_table' }
  | { readonly mode: 'append'; readonly tableId: string; readonly tableName: string };
