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
