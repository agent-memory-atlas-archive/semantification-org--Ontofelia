// Minimal local typing: @types/js-yaml is not available offline. Only `load` and
// the CORE_SCHEMA are used (see ingestion/VaultImporter.ts, export/VaultExporter.ts).
declare module 'js-yaml' {
  export interface LoadOptions { schema?: unknown }
  export const CORE_SCHEMA: unknown;
  export interface DumpOptions {
    schema?: unknown;
    sortKeys?: boolean;
    lineWidth?: number;
    noRefs?: boolean;
    quotingType?: "'" | '"';
    forceQuotes?: boolean;
  }
  export function dump(input: unknown, options?: DumpOptions): string;
  export function load(input: string, options?: LoadOptions): unknown;
}
