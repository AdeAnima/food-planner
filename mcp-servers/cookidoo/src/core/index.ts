// cookidoo-core — public API barrel.
// Pure Cookidoo access library: reverse-engineered Vorwerk Thermomix web+cookie API.
// No MCP, no server. Consumed in-process by cookidoo-mcp (and any other client).
//
// Re-exports the full surface of the three access modules. The cross-file surface
// that cookidoo-mcp's index.ts and migrate.ts already depend on is a strict subset
// of this; exporting everything keeps the library's API complete for standalone use.
export * from "./auth.ts";
export * from "./cookidoo.ts";
export * from "./migrate.ts";
