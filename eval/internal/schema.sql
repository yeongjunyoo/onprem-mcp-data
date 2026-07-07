-- WS-A internal contest-grade benchmark schema (isolated in schema `bench`).
--
-- Kept SEPARATE from the public smoke seed (sql/init/01_schema.sql) so the 140
-- regression tests stay valid. The benchmark exercises the engine on a realistic
-- multi-table e-commerce domain (thousands of rows) with joins, time filters,
-- aggregates, synonyms, nulls, and permission/no-answer cases.
--
-- KG tables (entities/aliases/relations/entity_links) are added in Gate2 (WS-B).

CREATE EXTENSION IF NOT EXISTS vector;
DROP SCHEMA IF EXISTS bench CASCADE;
CREATE SCHEMA bench;

-- dimension: product categories
CREATE TABLE bench.categories (
  id    int PRIMARY KEY,
  name  text NOT NULL                  -- '의류','전자','식품',...
);

-- dimension: customers
CREATE TABLE bench.customers (
  id          int PRIMARY KEY,
  name        text NOT NULL,
  segment     text NOT NULL,           -- 'vip' | 'regular' | 'new'
  region      text NOT NULL,           -- '서울','경기','부산',...
  created_at  date NOT NULL
);

-- dimension: products (nullable supplier to exercise NULL handling)
CREATE TABLE bench.products (
  id           int PRIMARY KEY,
  name         text NOT NULL,
  category_id  int NOT NULL REFERENCES bench.categories(id),
  price        int NOT NULL,           -- KRW
  supplier     text,                   -- nullable on purpose
  active       boolean NOT NULL DEFAULT true
);

-- fact: orders
CREATE TABLE bench.orders (
  id          int PRIMARY KEY,
  customer_id int NOT NULL REFERENCES bench.customers(id),
  status      text NOT NULL,           -- 'paid' | 'cancelled' | 'refunded' | 'shipped'
  total       int NOT NULL,            -- KRW (sum of items)
  created_at  date NOT NULL
);

-- fact: order line items
CREATE TABLE bench.order_items (
  id          int PRIMARY KEY,
  order_id    int NOT NULL REFERENCES bench.orders(id),
  product_id  int NOT NULL REFERENCES bench.products(id),
  qty         int NOT NULL,
  unit_price  int NOT NULL
);

-- fact: support tickets (order optional -> NULL / no-answer cases)
CREATE TABLE bench.support_tickets (
  id          int PRIMARY KEY,
  customer_id int NOT NULL REFERENCES bench.customers(id),
  order_id    int REFERENCES bench.orders(id),
  reason      text NOT NULL,           -- '환불요청','배송지연','상품불량','단순문의'
  status      text NOT NULL,           -- 'open' | 'resolved' | 'escalated'
  created_at  date NOT NULL
);

-- semantic side: policy / FAQ documents (pgvector)
CREATE TABLE bench.documents (
  id        int PRIMARY KEY,
  title     text NOT NULL,
  body      text NOT NULL,
  doc_type  text NOT NULL,             -- 'policy' | 'faq' | 'guide'
  embedding vector(1024)               -- BGE-M3 dim; backfilled in Gate3 (WS-C)
);

-- sensitive table the read-only role must NOT see (permission-denied eval cases)
CREATE TABLE bench.admin_secrets (
  id     int PRIMARY KEY,
  secret text NOT NULL
);

CREATE INDEX ON bench.orders (customer_id);
CREATE INDEX ON bench.orders (status);
CREATE INDEX ON bench.orders (created_at);
CREATE INDEX ON bench.order_items (order_id);
CREATE INDEX ON bench.order_items (product_id);
CREATE INDEX ON bench.products (category_id);
CREATE INDEX ON bench.support_tickets (customer_id);


-- ===== Knowledge graph (Gate2 contract) =====
-- entities: canonical nodes (product/category/policy/...).
CREATE TABLE bench.entities (
  id             int PRIMARY KEY,
  type           text NOT NULL,        -- 'product' | 'category' | 'policy' | 'customer_segment'
  canonical_name text NOT NULL
);
-- aliases: synonyms (Korean/English) -> canonical entity (powers ontology.search).
CREATE TABLE bench.aliases (
  entity_id int NOT NULL REFERENCES bench.entities(id),
  alias     text NOT NULL,
  lang      text NOT NULL              -- 'ko' | 'en'
);
-- relations: typed directed edges with provenance (powers graph.expand).
CREATE TABLE bench.relations (
  id            int PRIMARY KEY,
  src_entity_id int NOT NULL REFERENCES bench.entities(id),
  rel_type      text NOT NULL,         -- 'in_category' | 'applies_to' | 'substitutes' | 'escalates_to'
  dst_entity_id int NOT NULL REFERENCES bench.entities(id),
  confidence    numeric NOT NULL DEFAULT 1.0,
  provenance    text NOT NULL
);
-- entity_links: bridge an entity to its source row / document span (canonical identity contract).
CREATE TABLE bench.entity_links (
  entity_id    int NOT NULL REFERENCES bench.entities(id),
  source_kind  text NOT NULL,          -- 'sql' | 'vector'
  source_table text,                   -- e.g. 'products', 'categories'
  source_pk    int,                    -- PK in source_table
  document_id  int,                    -- bench.documents.id when source_kind='vector'
  span_start   int,
  span_end     int,
  provenance   text NOT NULL
);
CREATE INDEX ON bench.aliases (entity_id);
CREATE INDEX ON bench.aliases (alias);
CREATE INDEX ON bench.relations (src_entity_id);
CREATE INDEX ON bench.relations (dst_entity_id);
CREATE INDEX ON bench.entity_links (entity_id);
CREATE INDEX ON bench.entity_links (source_table, source_pk);
