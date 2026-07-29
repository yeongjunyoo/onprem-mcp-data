#!/usr/bin/env node
// onprem-mcp-data — air MCP server entrypoint (리원에이스 지정과제).
//
// Single-runtime, fully on-prem MCP data platform. air gives us the MCP server +
// stability plugins (timeout/retry/circuit-breaker = "fewer failure points") for
// free; we add the differentiators: L3 deterministic router (MCP Parallel), the
// L2 DB tools over PostgreSQL+pgvector, and (next increment) L4 structure-
// preserving curation + the 7B answer step. The server wiring lives in
// server.ts (buildServer) so tests can exercise it without opening stdio.

import { buildServer } from "./server.js";

buildServer().start();
