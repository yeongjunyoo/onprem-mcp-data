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

-- L1 substrate: pgvector + a tiny seed schema for the smoke test.
CREATE EXTENSION IF NOT EXISTS vector;

-- structured side (for the SQL tool / router STRUCTURED route)
CREATE TABLE IF NOT EXISTS orders (
  id          serial PRIMARY KEY,
  user_id     int  NOT NULL,
  status      text NOT NULL,         -- 'paid' | 'cancelled' | 'refunded'
  amount      int  NOT NULL,
  created_at  date NOT NULL
);

-- semantic side (for the vector tool / router SEMANTIC route)
CREATE TABLE IF NOT EXISTS documents (
  id        serial PRIMARY KEY,
  title     text NOT NULL,
  body      text NOT NULL,
  embedding vector(1024)             -- BGE-m3 dim; filled by the app, nullable for now
);

INSERT INTO orders (user_id, status, amount, created_at) VALUES
  (1,'paid',12000,'2026-04-02'),(1,'refunded',8000,'2026-04-10'),
  (2,'paid',30000,'2026-05-01'),(3,'cancelled',5000,'2026-05-20'),
  (2,'paid',15000,'2026-06-15')
ON CONFLICT DO NOTHING;

INSERT INTO documents (title, body) VALUES
  ('환불 정책','단순 변심 반품은 수령 후 7일 이내 가능하며 택배비는 고객 부담입니다.'),
  ('배송 안내','출고 후 보통 2~3일 내 도착하며 운송장은 문자로 안내됩니다.'),
  ('멤버십 등급','최근 6개월 구매 실적으로 매월 1일 등급이 갱신됩니다.')
ON CONFLICT DO NOTHING;
