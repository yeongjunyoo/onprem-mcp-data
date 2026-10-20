-- Company-X 컬럼 주석 초안 (사람 검토용, 자동 생성).
-- 생성: 2026-10-11T14:16:17.556Z  대상: localhost:5433/mcpdata_g20a  스키마: companyx  표 8개
-- 원천: information_schema.columns, pg_stats(통계가 없는 표는 정확 집계), pg_constraint.
-- 이 파일을 그대로 적용하지 않는다. 검토자가 TODO(뜻, 단위, 자주 쓰는 조건)를 채워 sql/companyx/comments.sql 로 옮긴다.
-- 규칙: IS 뒤 문자열에는 뜻, 타입, 추상 범위, 단위, 자주 쓰는 조건(SQL)만 쓴다. 값 예시는 쓰지 않는다.
--       [검토 힌트] 줄은 SQL 주석이라 카탈로그에도 카드에도 들어가지 않는다. 값 목록을 주석으로 옮기지 않고, 업무 용어와
--       저장 값이 갈리는 것만 조건 SQL 로 적는다(미해결 = status IN (…)). 데이터에서 참인 조건만 적는다.

-- ===== companyx.departments — 6행, 통계 정확 집계(pg_stats 없음) =====
COMMENT ON TABLE companyx.departments IS $$TODO: 한 행이 무엇인지$$;

-- departments.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 6, 고유값 6, NULL 0%
COMMENT ON COLUMN companyx.departments.id IS $$기본키(행 번호). 정수.$$;

-- departments.name  character varying NOT NULL
--   [검토 힌트] 고유값 6, NULL 0%
--   [검토 힌트] 값 6가지(빈도): '영업팀' 17%, '경영지원팀' 17%, '기술지원팀' 17%, '보안솔루션팀' 17%, '데이터플랫폼팀' 17%, '클라우드사업부' 17%
COMMENT ON COLUMN companyx.departments.name IS $$TODO 뜻. 문자열, 행마다 다른 값. TODO 단위나 자주 쓰는 조건.$$;

-- departments.head_id  integer, 외래키 → companyx.employees.id
--   [검토 힌트] 최소 1, 최대 6, 고유값 6, NULL 0%
COMMENT ON COLUMN companyx.departments.head_id IS $$employees.id 를 가리키는 번호. 정수.$$;

-- departments.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.departments.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.employees — 45행, 통계 정확 집계(pg_stats 없음) =====
COMMENT ON TABLE companyx.employees IS $$TODO: 한 행이 무엇인지$$;

-- employees.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 45, 고유값 45, NULL 0%
COMMENT ON COLUMN companyx.employees.id IS $$기본키(행 번호). 정수.$$;

-- employees.name  character varying NOT NULL
--   [검토 힌트] 고유값 44, NULL 0%
COMMENT ON COLUMN companyx.employees.name IS $$TODO 뜻. 문자열, 자유 텍스트.$$;

-- employees.email  character varying NOT NULL
--   [검토 힌트] 고유값 45, NULL 0%
COMMENT ON COLUMN companyx.employees.email IS $$TODO 뜻. 문자열, 행마다 다른 값.$$;

-- employees.position  character varying NOT NULL
--   [검토 힌트] 고유값 6, NULL 0%
--   [검토 힌트] 값 6가지(빈도): '차장' 38%, '과장' 20%, '사원' 18%, '대리' 11%, '부장' 7%, '이사' 7%
COMMENT ON COLUMN companyx.employees.position IS $$TODO 뜻. 문자열, 6가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- employees.dept_id  integer NOT NULL, 외래키 → companyx.departments.id
--   [검토 힌트] 최소 1, 최대 6, 고유값 6, NULL 0%
COMMENT ON COLUMN companyx.employees.dept_id IS $$departments.id 를 가리키는 번호. 정수.$$;

-- employees.hire_date  date NOT NULL
--   [검토 힌트] 최소 2020-01-09, 최대 2025-07-05, 고유값 45, NULL 0%
COMMENT ON COLUMN companyx.employees.hire_date IS $$TODO 뜻. 날짜, 2020년~2025년 사이 날짜.$$;

-- employees.salary  integer NOT NULL
--   [검토 힌트] 최소 3736, 최대 9520, 고유값 45, NULL 0%
COMMENT ON COLUMN companyx.employees.salary IS $$TODO 뜻. 정수, 0 이상, 수천. TODO 단위나 자주 쓰는 조건.$$;

-- employees.is_active  boolean
--   [검토 힌트] 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): 'true' 100%
COMMENT ON COLUMN companyx.employees.is_active IS $$TODO 뜻. 참거짓, 참 또는 거짓. TODO 단위나 자주 쓰는 조건.$$;

-- employees.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.employees.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.clients — 30행, 통계 정확 집계(pg_stats 없음) =====
COMMENT ON TABLE companyx.clients IS $$TODO: 한 행이 무엇인지$$;

-- clients.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 30, 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.clients.id IS $$기본키(행 번호). 정수.$$;

-- clients.name  character varying NOT NULL
--   [검토 힌트] 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.clients.name IS $$TODO 뜻. 문자열, 행마다 다른 값.$$;

-- clients.industry  character varying NOT NULL
--   [검토 힌트] 고유값 10, NULL 0%
--   [검토 힌트] 값 10가지(빈도): '건설' 10%, '교육' 10%, '금융' 10%, '미디어' 10%, '에너지' 10%, '제조업' 10%, '공공기관' 10%, '유통/물류' 10%, '의료/바이오' 10%, 'IT/SW' 10%
COMMENT ON COLUMN companyx.clients.industry IS $$TODO 뜻. 문자열, 10가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- clients.region  character varying NOT NULL
--   [검토 힌트] 고유값 8, NULL 0%
--   [검토 힌트] 값 8가지(빈도): '경기' 13%, '대구' 13%, '대전' 13%, '부산' 13%, '서울' 13%, '인천' 13%, '광주' 10%, '제주' 10%
COMMENT ON COLUMN companyx.clients.region IS $$TODO 뜻. 문자열, 8가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- clients.company_size  character varying NOT NULL
--   [검토 힌트] 고유값 3, NULL 0%
--   [검토 힌트] 값 3가지(빈도): 'enterprise' 33%, 'mid' 33%, 'startup' 33%
COMMENT ON COLUMN companyx.clients.company_size IS $$TODO 뜻. 문자열, 3가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- clients.contact_name  character varying
--   [검토 힌트] 고유값 29, NULL 0%
COMMENT ON COLUMN companyx.clients.contact_name IS $$TODO 뜻. 문자열, 자유 텍스트.$$;

-- clients.contact_email  character varying
--   [검토 힌트] 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.clients.contact_email IS $$TODO 뜻. 문자열, 행마다 다른 값.$$;

-- clients.registered_at  date NOT NULL
--   [검토 힌트] 최소 2023-01-17, 최대 2025-12-19, 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.clients.registered_at IS $$TODO 뜻. 날짜, 2023년~2025년 사이 날짜.$$;

-- clients.is_active  boolean
--   [검토 힌트] 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): 'true' 100%
COMMENT ON COLUMN companyx.clients.is_active IS $$TODO 뜻. 참거짓, 참 또는 거짓. TODO 단위나 자주 쓰는 조건.$$;

-- clients.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.clients.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.products — 12행, 통계 정확 집계(pg_stats 없음) =====
COMMENT ON TABLE companyx.products IS $$TODO: 한 행이 무엇인지$$;

-- products.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 12, 고유값 12, NULL 0%
COMMENT ON COLUMN companyx.products.id IS $$기본키(행 번호). 정수.$$;

-- products.name  character varying NOT NULL
--   [검토 힌트] 고유값 12, NULL 0%
--   [검토 힌트] 값 12가지(빈도): 'Product-C1' 8%, 'Product-C2' 8%, 'Product-C3' 8%, 'Product-C4' 8%, 'Product-D1' 8%, 'Product-D2' 8%, 'Product-D3' 8%, 'Product-S1' 8%, 'Product-S2' 8%, 'Product-S3' 8%, 'Product-T1' 8%, 'Product-T2' 8%
COMMENT ON COLUMN companyx.products.name IS $$TODO 뜻. 문자열, 행마다 다른 값. TODO 단위나 자주 쓰는 조건.$$;

-- products.category  character varying NOT NULL
--   [검토 힌트] 고유값 4, NULL 0%
--   [검토 힌트] 값 4가지(빈도): 'cloud' 33%, 'data' 25%, 'security' 25%, 'consulting' 17%
COMMENT ON COLUMN companyx.products.category IS $$TODO 뜻. 문자열, 4가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- products.description  text
--   [검토 힌트] 고유값 12, NULL 0%
--   [검토 힌트] 값 12가지(긴 문자열이라 값은 생략)
COMMENT ON COLUMN companyx.products.description IS $$TODO 뜻. 문자열, 행마다 다른 값. TODO 단위나 자주 쓰는 조건.$$;

-- products.price_monthly  integer NOT NULL
--   [검토 힌트] 최소 80, 최대 500, 고유값 12, NULL 0%
--   [검토 힌트] 값 12가지(빈도): '100' 8%, '120' 8%, '150' 8%, '160' 8%, '180' 8%, '200' 8%, '250' 8%, '280' 8%, '350' 8%, '400' 8%, '500' 8%, '80' 8%
COMMENT ON COLUMN companyx.products.price_monthly IS $$TODO 뜻. 정수, 0 이상, 수십~수백. TODO 단위나 자주 쓰는 조건.$$;

-- products.version  character varying
--   [검토 힌트] 고유값 11, NULL 0%
--   [검토 힌트] 값 11가지(빈도): '1.0' 17%, '2.1.0' 8%, '2.3.7' 8%, '2.9.5' 8%, '3.2.1' 8%, '3.7.5' 8%, '4.0.9' 8%, '4.4.1' 8%, '4.6.7' 8%, '4.7.4' 8%, '5.6.3' 8%
COMMENT ON COLUMN companyx.products.version IS $$TODO 뜻. 문자열, 11가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- products.release_date  date
--   [검토 힌트] 최소 2023-03-16, 최대 2025-09-10, 고유값 11, NULL 0%
--   [검토 힌트] 값 11가지(빈도): '2023-03-16' 17%, '2023-06-26' 8%, '2024-02-16' 8%, '2024-08-01' 8%, '2024-10-16' 8%, '2024-11-21' 8%, '2025-03-22' 8%, '2025-04-24' 8%, '2025-05-27' 8%, '2025-06-15' 8%, '2025-09-10' 8%
COMMENT ON COLUMN companyx.products.release_date IS $$TODO 뜻. 날짜, 2023년~2025년 사이 날짜. TODO 단위나 자주 쓰는 조건.$$;

-- products.status  character varying
--   [검토 힌트] 고유값 2, NULL 0%
--   [검토 힌트] 값 2가지(빈도): 'active' 83%, 'beta' 17%
COMMENT ON COLUMN companyx.products.status IS $$TODO 뜻. 문자열, 2가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- products.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.products.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.contracts — 65행, 통계 pg_stats =====
COMMENT ON TABLE companyx.contracts IS $$TODO: 한 행이 무엇인지$$;

-- contracts.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 65, 고유값 65, NULL 0%
COMMENT ON COLUMN companyx.contracts.id IS $$기본키(행 번호). 정수.$$;

-- contracts.client_id  integer NOT NULL, 외래키 → companyx.clients.id
--   [검토 힌트] 최소 1, 최대 30, 고유값 27, NULL 0%
COMMENT ON COLUMN companyx.contracts.client_id IS $$clients.id 를 가리키는 번호. 정수.$$;

-- contracts.product_id  integer NOT NULL, 외래키 → companyx.products.id
--   [검토 힌트] 최소 1, 최대 12, 고유값 12, NULL 0%
COMMENT ON COLUMN companyx.contracts.product_id IS $$products.id 를 가리키는 번호. 정수.$$;

-- contracts.manager_id  integer NOT NULL, 외래키 → companyx.employees.id
--   [검토 힌트] 최소 2, 최대 45, 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.contracts.manager_id IS $$employees.id 를 가리키는 번호. 정수.$$;

-- contracts.contract_type  character varying NOT NULL
--   [검토 힌트] 고유값 3, NULL 0%
--   [검토 힌트] 값 3가지(빈도): 'project' 40%, 'subscription' 32%, 'maintenance' 28%
COMMENT ON COLUMN companyx.contracts.contract_type IS $$TODO 뜻. 문자열, 3가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- contracts.amount  integer NOT NULL
--   [검토 힌트] 최소 480, 최대 11000, 고유값 50, NULL 0%
COMMENT ON COLUMN companyx.contracts.amount IS $$TODO 뜻. 정수, 0 이상, 수백~수만. TODO 단위나 자주 쓰는 조건.$$;

-- contracts.start_date  date NOT NULL
--   [검토 힌트] 최소 2024-02-21, 최대 2026-03-05, 고유값 63, NULL 0%
COMMENT ON COLUMN companyx.contracts.start_date IS $$TODO 뜻. 날짜, 2024년~2026년 사이 날짜.$$;

-- contracts.end_date  date
--   [검토 힌트] 최소 2025-01-16, 최대 2027-12-29, 고유값 62, NULL 0%
COMMENT ON COLUMN companyx.contracts.end_date IS $$TODO 뜻. 날짜, 2025년~2027년 사이 날짜.$$;

-- contracts.status  character varying
--   [검토 힌트] 고유값 3, NULL 0%
--   [검토 힌트] 값 3가지(빈도): 'active' 71%, 'cancelled' 15%, 'completed' 14%
COMMENT ON COLUMN companyx.contracts.status IS $$TODO 뜻. 문자열, 3가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- contracts.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.contracts.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.projects — 40행, 통계 정확 집계(pg_stats 없음) =====
COMMENT ON TABLE companyx.projects IS $$TODO: 한 행이 무엇인지$$;

-- projects.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 40, 고유값 40, NULL 0%
COMMENT ON COLUMN companyx.projects.id IS $$기본키(행 번호). 정수.$$;

-- projects.name  character varying NOT NULL
--   [검토 힌트] 고유값 39, NULL 0%
COMMENT ON COLUMN companyx.projects.name IS $$TODO 뜻. 문자열, 자유 텍스트.$$;

-- projects.client_id  integer NOT NULL, 외래키 → companyx.clients.id
--   [검토 힌트] 최소 2, 최대 29, 고유값 22, NULL 0%
COMMENT ON COLUMN companyx.projects.client_id IS $$clients.id 를 가리키는 번호. 정수.$$;

-- projects.manager_id  integer NOT NULL, 외래키 → companyx.employees.id
--   [검토 힌트] 최소 2, 최대 45, 고유값 19, NULL 0%
COMMENT ON COLUMN companyx.projects.manager_id IS $$employees.id 를 가리키는 번호. 정수.$$;

-- projects.contract_id  integer, 외래키 → companyx.contracts.id
--   [검토 힌트] 최소 3, 최대 64, 고유값 32, NULL 0%
COMMENT ON COLUMN companyx.projects.contract_id IS $$contracts.id 를 가리키는 번호. 정수.$$;

-- projects.status  character varying
--   [검토 힌트] 고유값 4, NULL 0%
--   [검토 힌트] 값 4가지(빈도): 'in_progress' 45%, 'on_hold' 25%, 'completed' 15%, 'planning' 15%
COMMENT ON COLUMN companyx.projects.status IS $$TODO 뜻. 문자열, 4가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- projects.start_date  date NOT NULL
--   [검토 힌트] 최소 2024-03-14, 최대 2026-06-23, 고유값 40, NULL 0%
COMMENT ON COLUMN companyx.projects.start_date IS $$TODO 뜻. 날짜, 2024년~2026년 사이 날짜.$$;

-- projects.end_date  date
--   [검토 힌트] 최소 2024-06-07, 최대 2027-06-09, 고유값 29, NULL 28%
COMMENT ON COLUMN companyx.projects.end_date IS $$TODO 뜻. 날짜, 2024년~2027년 사이 날짜. 비어 있을 수 있다(NULL).$$;

-- projects.budget  integer
--   [검토 힌트] 최소 898, 최대 14738, 고유값 40, NULL 0%
COMMENT ON COLUMN companyx.projects.budget IS $$TODO 뜻. 정수, 0 이상, 수백~수만. TODO 단위나 자주 쓰는 조건.$$;

-- projects.description  text
--   [검토 힌트] 고유값 40, NULL 0%
COMMENT ON COLUMN companyx.projects.description IS $$TODO 뜻. 문자열, 행마다 다른 값.$$;

-- projects.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.projects.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.sales — 500행, 통계 pg_stats =====
COMMENT ON TABLE companyx.sales IS $$TODO: 한 행이 무엇인지$$;

-- sales.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 500, 고유값 500, NULL 0%
COMMENT ON COLUMN companyx.sales.id IS $$기본키(행 번호). 정수.$$;

-- sales.contract_id  integer NOT NULL, 외래키 → companyx.contracts.id
--   [검토 힌트] 최소 1, 최대 65, 고유값 65, NULL 0%
COMMENT ON COLUMN companyx.sales.contract_id IS $$contracts.id 를 가리키는 번호. 정수.$$;

-- sales.client_id  integer NOT NULL, 외래키 → companyx.clients.id
--   [검토 힌트] 최소 1, 최대 30, 고유값 27, NULL 0%
COMMENT ON COLUMN companyx.sales.client_id IS $$clients.id 를 가리키는 번호. 정수.$$;

-- sales.product_id  integer NOT NULL, 외래키 → companyx.products.id
--   [검토 힌트] 최소 1, 최대 12, 고유값 12, NULL 0%
COMMENT ON COLUMN companyx.sales.product_id IS $$products.id 를 가리키는 번호. 정수.$$;

-- sales.amount  integer NOT NULL
--   [검토 힌트] 최소 65, 최대 2078, 고유값 397, NULL 0%
COMMENT ON COLUMN companyx.sales.amount IS $$TODO 뜻. 정수, 0 이상, 수십~수천. TODO 단위나 자주 쓰는 조건.$$;

-- sales.sale_date  date NOT NULL
--   [검토 힌트] 최소 2024-01-11, 최대 2026-06-27, 고유값 389, NULL 0%
COMMENT ON COLUMN companyx.sales.sale_date IS $$TODO 뜻. 날짜, 2024년~2026년 사이 날짜.$$;

-- sales.quarter  character varying NOT NULL
--   [검토 힌트] 고유값 10, NULL 0%
--   [검토 힌트] 값 10가지(빈도): '2024-Q2' 12%, '2026-Q1' 12%, '2025-Q4' 11%, '2025-Q1' 11%, '2026-Q2' 10%, '2024-Q4' 10%, '2024-Q1' 9%, '2025-Q2' 9%, '2025-Q3' 8%, '2024-Q3' 7%
COMMENT ON COLUMN companyx.sales.quarter IS $$TODO 뜻. 문자열, 10가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- sales.category  character varying NOT NULL
--   [검토 힌트] 고유값 4, NULL 0%
--   [검토 힌트] 값 4가지(빈도): 'cloud' 36%, 'security' 35%, 'data' 17%, 'consulting' 12%
COMMENT ON COLUMN companyx.sales.category IS $$TODO 뜻. 문자열, 4가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- sales.region  character varying NOT NULL
--   [검토 힌트] 고유값 8, NULL 0%
--   [검토 힌트] 값 8가지(빈도): '서울' 21%, '인천' 19%, '대전' 18%, '경기' 14%, '제주' 11%, '대구' 9%, '부산' 5%, '광주' 3%
COMMENT ON COLUMN companyx.sales.region IS $$TODO 뜻. 문자열, 8가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- sales.created_at  timestamp without time zone
--   [검토 힌트] 최소 2026-10-08 16:49:39.311807, 최대 2026-10-08 16:49:39.311807, 고유값 1, NULL 0%
--   [검토 힌트] 값 1가지(빈도): '2026-10-08 16:49:39.311807' 100%
COMMENT ON COLUMN companyx.sales.created_at IS $$TODO 뜻. 시각, 2026년 안의 시각. TODO 단위나 자주 쓰는 조건.$$;

-- ===== companyx.support_tickets — 120행, 통계 pg_stats =====
COMMENT ON TABLE companyx.support_tickets IS $$TODO: 한 행이 무엇인지$$;

-- support_tickets.id  integer NOT NULL, 기본키
--   [검토 힌트] 최소 1, 최대 120, 고유값 120, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.id IS $$기본키(행 번호). 정수.$$;

-- support_tickets.client_id  integer NOT NULL, 외래키 → companyx.clients.id
--   [검토 힌트] 최소 1, 최대 30, 고유값 30, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.client_id IS $$clients.id 를 가리키는 번호. 정수.$$;

-- support_tickets.product_id  integer NOT NULL, 외래키 → companyx.products.id
--   [검토 힌트] 최소 1, 최대 12, 고유값 12, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.product_id IS $$products.id 를 가리키는 번호. 정수.$$;

-- support_tickets.assignee_id  integer, 외래키 → companyx.employees.id
--   [검토 힌트] 최소 5, 최대 41, 고유값 4, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.assignee_id IS $$employees.id 를 가리키는 번호. 정수.$$;

-- support_tickets.title  character varying NOT NULL
--   [검토 힌트] 고유값 28, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.title IS $$TODO 뜻. 문자열, 자유 텍스트.$$;

-- support_tickets.description  text
--   [검토 힌트] 고유값 5, NULL 0%
--   [검토 힌트] 값 5가지(긴 문자열이라 값은 생략)
COMMENT ON COLUMN companyx.support_tickets.description IS $$TODO 뜻. 문자열, 5가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- support_tickets.priority  character varying NOT NULL
--   [검토 힌트] 고유값 4, NULL 0%
--   [검토 힌트] 값 4가지(빈도): 'medium' 36%, 'high' 25%, 'critical' 22%, 'low' 17%
COMMENT ON COLUMN companyx.support_tickets.priority IS $$TODO 뜻. 문자열, 4가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- support_tickets.status  character varying
--   [검토 힌트] 고유값 4, NULL 0%
--   [검토 힌트] 값 4가지(빈도): 'resolved' 39%, 'closed' 33%, 'in_progress' 16%, 'open' 12%
COMMENT ON COLUMN companyx.support_tickets.status IS $$TODO 뜻. 문자열, 4가지 코드 값. TODO 단위나 자주 쓰는 조건.$$;

-- support_tickets.created_at  timestamp without time zone NOT NULL
--   [검토 힌트] 최소 2024-06-06 17:24:23, 최대 2026-06-24 11:48:17, 고유값 120, NULL 0%
COMMENT ON COLUMN companyx.support_tickets.created_at IS $$TODO 뜻. 시각, 2024년~2026년 사이 시각.$$;

-- support_tickets.resolved_at  timestamp without time zone
--   [검토 힌트] 최소 2024-07-05 19:18:47, 최대 2026-06-26 01:18:59, 고유값 87, NULL 28%
COMMENT ON COLUMN companyx.support_tickets.resolved_at IS $$TODO 뜻. 시각, 2024년~2026년 사이 시각. 비어 있을 수 있다(NULL).$$;

