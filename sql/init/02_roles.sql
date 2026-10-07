-- Copyright 2026 Yeongjun Yoo
-- SPDX-License-Identifier: Apache-2.0
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Least-privilege role for the sql.query tool.
--
-- The app connects as the owner (for setup like embedding backfill), but the
-- sql.query tool drops to this NOLOGIN role via `SET LOCAL ROLE mcp_ro` inside
-- its read-only transaction. mcp_ro has SELECT only and is NOT a superuser, so
-- superuser-only functions (pg_read_file, pg_ls_dir, ...) and any write are
-- rejected at the database layer — a real privilege boundary, not just a regex.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mcp_ro') THEN
    CREATE ROLE mcp_ro NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_ro;
