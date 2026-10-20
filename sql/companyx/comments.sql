-- Copyright 2026 Yeongjun Yoo
-- SPDX-License-Identifier: Apache-2.0
--
-- Company-X 표와 컬럼 주석 — 검토를 마친 판(DBA 검토본).
--
-- 리원에이스 CTO 서면 답변(2026-10-03, Q5)을 따른다. 주석에는 컬럼의 뜻, 타입, 추상 범위, 단위, 자주 쓰는 조건(SQL)만
-- 쓰고 값 예시는 쓰지 않는다. 범위는 「2020년 이후」처럼 연도나 자릿수(수십, 수천)로만 적는다. 코드 컬럼의 값은 조건
-- SQL(미해결 = status IN (…)) 안에서만 나온다.
--
-- 어디에 쓰이나
--   * 적재: npm run companyx:load 가 표와 데이터를 만든 뒤 같은 트랜잭션에서 이 파일을 실행한다(companyx.ts loadCompanyX).
--   * 카드: SQL_CARD=comments 로 띄운 서버가 기동 때 카탈로그(col_description, obj_description)에서 이 주석을 읽어
--     NL2SQL 스키마 카드를 만든다(schemacomments.ts). 카드의 각 줄은 「컬럼 타입[키]  -- 주석」이라 SQL 타입과 키는
--     카탈로그가 대고, 주석은 그 옆에 뜻과 범위를 단다. 이 파일의 -- 줄은 카탈로그에 들어가지 않는다.
--   * 이미 적재한 DB 에 따로 걸 때: docker compose exec -T db psql -U postgres -d mcpdata < sql/companyx/comments.sql
--     (COMMENT 는 몇 번 걸어도 같다. 주석을 고치면 서버를 다시 띄워야 카드가 바뀐다 — 기동 때 한 번 읽는다.)
--
-- 초안은 npm run companyx:comments-draft 가 통계로 만든다(sql/companyx/comments.draft.sql). 이 판은 그 초안을 사람이
-- 검토해 채운 것이다. 검토 근거(2026-10-11, 사본 DB 의 적재 데이터와 데이터셋 문서로 확인):
--   * 금액 단위 만원: 제안서 문서의 「월 운영비 350만원」(DOC-031, Product-C1)이 products.price_monthly = 350 과 같다
--     (DOC-032, DOC-035 도 같다). 연봉, 계약 금액, 예산, 매출액도 같은 규모라 만원으로 적는다.
--   * sales.quarter 는 500행 모두 sale_date 의 연도-분기와 같고, sales.region 과 sales.category 는 모두 고객사 지역,
--     제품 분류와 같다. sales 의 고객사와 제품은 모두 그 계약의 것과 같다.
--   * 티켓의 미해결(open, in_progress) 33건은 모두 resolved_at 이 비었고, 해결(resolved, closed) 87건은 모두 찼다.
--     resolved_at 은 언제나 created_at 뒤다.
--   * 계약은 모두 종료일이 시작일보다 늦다. 종료일이 2026-10-11 보다 앞인데 status 가 'active' 인 계약이 31건 있다.
--   * 프로젝트 40건 가운데 38건은 contract_id 로 이은 계약의 고객사가 projects.client_id 와 다르다.
--   * 부서장(head_id)은 6개 부서 모두 그 부서 소속 직원이다. 직원 이름은 45명에 44가지(동명이인 한 쌍)다.
--   * 범위의 연도와 자릿수는 초안의 최솟값, 최댓값에서 읽었다.
-- 주석을 달지 않은 컬럼: 기본키 id(카드가 제약에서 「id int PRIMARY KEY」로 싣는다)와 departments, employees, clients,
--   products, contracts, projects, sales 의 created_at(적재 때 찍힌 시각이라 모든 행이 같다. 업무 날짜가 아니어서 카드에서 뺀다).
-- 주석 문자열에 다음 낱말을 쓰지 않는다. 없는 항목을 거르는 검사(notfound.ts absentAttribute)는 카드에 그 낱말이 있으면
--   그 항목이 데이터에 있다고 본다: 나이, 생일(「발생일」 포함), 성별, 주소(「메일 주소」 포함), 전화번호, 연차, 휴가, 근태, 성과 따위.

-- 부서
COMMENT ON TABLE companyx.departments IS $$부서. 한 행이 부서 하나.$$;
COMMENT ON COLUMN companyx.departments.name IS $$부서 이름(문자열, 부서마다 다름, …팀이나 …사업부 꼴).$$;
COMMENT ON COLUMN companyx.departments.head_id IS $$부서장 직원 id(정수). 부서장은 그 부서 소속이다.$$;

-- 직원
COMMENT ON TABLE companyx.employees IS $$우리 회사 직원. 한 행이 한 명. 고객사 쪽 담당자는 clients.contact_name 이다.$$;
COMMENT ON COLUMN companyx.employees.name IS $$직원 이름(한글 문자열, 동명이인 있음).$$;
COMMENT ON COLUMN companyx.employees.email IS $$직원 업무 메일(문자열, 직원마다 다름).$$;
COMMENT ON COLUMN companyx.employees.position IS $$직급(문자열). 직급 순서 = CASE position WHEN '사원' THEN 1 WHEN '대리' THEN 2 WHEN '과장' THEN 3 WHEN '차장' THEN 4 WHEN '부장' THEN 5 WHEN '이사' THEN 6 END$$;
COMMENT ON COLUMN companyx.employees.dept_id IS $$소속 부서 id(정수).$$;
COMMENT ON COLUMN companyx.employees.hire_date IS $$입사일(날짜, 2020년 이후). 근속 연수 = EXTRACT(YEAR FROM age(CURRENT_DATE, hire_date))$$;
COMMENT ON COLUMN companyx.employees.salary IS $$연봉(정수, 만원 단위 = 원 금액 ÷ 10000, 수천대).$$;
COMMENT ON COLUMN companyx.employees.is_active IS $$재직 여부(참거짓). 재직 중 = is_active$$;

-- 고객사
COMMENT ON TABLE companyx.clients IS $$고객사(거래처). 한 행이 고객사 하나.$$;
COMMENT ON COLUMN companyx.clients.name IS $$고객사 이름(문자열, 고객사마다 다름, 'Client-' 뒤에 영문 대문자 한두 자 꼴).$$;
COMMENT ON COLUMN companyx.clients.industry IS $$업종(한글 문자열, 두 업종을 / 로 묶은 이름도 있음). 업종 일부로 고를 때 = industry LIKE '%업종어%'$$;
COMMENT ON COLUMN companyx.clients.region IS $$소재 지역(문자열, 광역시도 이름의 앞 두 글자).$$;
COMMENT ON COLUMN companyx.clients.company_size IS $$기업 규모(코드 셋). 대기업 = company_size = 'enterprise', 중견기업 = company_size = 'mid', 스타트업 = company_size = 'startup'$$;
COMMENT ON COLUMN companyx.clients.contact_name IS $$고객사 쪽 연락 담당자 이름(문자열, 우리 직원 아님).$$;
COMMENT ON COLUMN companyx.clients.contact_email IS $$고객사 쪽 연락 담당자 메일(문자열).$$;
COMMENT ON COLUMN companyx.clients.registered_at IS $$고객사 등록일(날짜, 2023년 이후). 신규 고객사는 이 날짜로 고른다.$$;
COMMENT ON COLUMN companyx.clients.is_active IS $$거래 여부(참거짓). 거래 중 = is_active$$;

-- 제품
COMMENT ON TABLE companyx.products IS $$우리 회사 제품과 솔루션. 한 행이 제품 하나.$$;
COMMENT ON COLUMN companyx.products.name IS $$제품 이름(문자열, 제품마다 다름, 'Product-' 뒤에 영문 대문자 한 자와 숫자 한 자 꼴).$$;
COMMENT ON COLUMN companyx.products.category IS $$제품 분류(코드 넷). 클라우드 = category = 'cloud', 보안 = category = 'security', 데이터 = category = 'data', 컨설팅 = category = 'consulting'$$;
COMMENT ON COLUMN companyx.products.description IS $$제품 설명(자유 서술 문자열).$$;
COMMENT ON COLUMN companyx.products.price_monthly IS $$월 이용료(정수, 만원 단위, 수십~수백).$$;
COMMENT ON COLUMN companyx.products.version IS $$제품 버전(점으로 나눈 숫자 문자열).$$;
COMMENT ON COLUMN companyx.products.release_date IS $$출시일(날짜, 2023년 이후).$$;
COMMENT ON COLUMN companyx.products.status IS $$판매 상태(코드 둘). 정식 판매 = status = 'active', 베타 = status = 'beta'$$;

-- 계약
COMMENT ON TABLE companyx.contracts IS $$고객사 계약. 한 행이 계약 하나(고객사 하나, 제품 하나).$$;
COMMENT ON COLUMN companyx.contracts.client_id IS $$계약 고객사 id(정수).$$;
COMMENT ON COLUMN companyx.contracts.product_id IS $$계약 제품 id(정수).$$;
COMMENT ON COLUMN companyx.contracts.manager_id IS $$계약 담당 직원 id(정수).$$;
COMMENT ON COLUMN companyx.contracts.contract_type IS $$계약 유형(코드 셋). 구독 = contract_type = 'subscription', 구축 프로젝트 = contract_type = 'project', 유지보수 = contract_type = 'maintenance'$$;
COMMENT ON COLUMN companyx.contracts.amount IS $$계약 금액(정수, 만원 단위, 수백~수만). 매출이 아니다.$$;
COMMENT ON COLUMN companyx.contracts.start_date IS $$계약 시작일(날짜, 2024년 이후).$$;
COMMENT ON COLUMN companyx.contracts.end_date IS $$계약 종료일(날짜, 2025년 이후, 시작일보다 늦음).$$;
COMMENT ON COLUMN companyx.contracts.status IS $$계약 상태(코드 셋). 활성 = status = 'active', 완료 = status = 'completed', 취소 = status = 'cancelled'. 종료일이 지난 활성 계약도 있어 상태는 status 로 고른다.$$;

-- 프로젝트
COMMENT ON TABLE companyx.projects IS $$고객사 프로젝트. 한 행이 프로젝트 하나.$$;
COMMENT ON COLUMN companyx.projects.name IS $$프로젝트 이름(문자열, 고객사 이름으로 시작).$$;
COMMENT ON COLUMN companyx.projects.client_id IS $$프로젝트 고객사 id(정수). 고객사는 이 컬럼으로 고른다(contract_id 계약의 고객사와 다를 수 있다).$$;
COMMENT ON COLUMN companyx.projects.manager_id IS $$프로젝트 담당(리드) 직원 id(정수).$$;
COMMENT ON COLUMN companyx.projects.contract_id IS $$관련 계약 id(정수).$$;
COMMENT ON COLUMN companyx.projects.status IS $$진행 상태(코드 넷). 계획 = status = 'planning', 진행 중 = status = 'in_progress', 완료 = status = 'completed', 보류 = status = 'on_hold'$$;
COMMENT ON COLUMN companyx.projects.start_date IS $$시작일(날짜, 2024년 이후).$$;
COMMENT ON COLUMN companyx.projects.end_date IS $$종료(예정)일(날짜, 미정이면 NULL).$$;
COMMENT ON COLUMN companyx.projects.budget IS $$예산(정수, 만원 단위, 수백~수만).$$;
COMMENT ON COLUMN companyx.projects.description IS $$프로젝트 설명(자유 서술 문자열).$$;

-- 매출
COMMENT ON TABLE companyx.sales IS $$매출 내역. 한 행이 계약 하나에서 난 매출 한 건.$$;
COMMENT ON COLUMN companyx.sales.contract_id IS $$매출이 난 계약 id(정수).$$;
COMMENT ON COLUMN companyx.sales.client_id IS $$매출 고객사 id(정수, 그 계약의 고객사).$$;
COMMENT ON COLUMN companyx.sales.product_id IS $$매출 제품 id(정수, 그 계약의 제품).$$;
COMMENT ON COLUMN companyx.sales.amount IS $$매출액(정수, 만원 단위, 수십~수천). 매출 합계 = SUM(amount)$$;
COMMENT ON COLUMN companyx.sales.sale_date IS $$매출 일자(날짜, 2024년 이후). 연도 = EXTRACT(YEAR FROM sale_date), 상반기 = EXTRACT(MONTH FROM sale_date) <= 6$$;
COMMENT ON COLUMN companyx.sales.quarter IS $$분기('YYYY-Qn' 꼴 문자열, 언제나 sale_date 의 분기). 분기 조건 = quarter = 'YYYY-Qn'$$;
COMMENT ON COLUMN companyx.sales.category IS $$매출 제품 분류(products.category 와 같은 코드 넷).$$;
COMMENT ON COLUMN companyx.sales.region IS $$매출 지역(clients.region 과 같은 두 글자 이름).$$;

-- 기술 지원 티켓
COMMENT ON TABLE companyx.support_tickets IS $$고객사 기술 지원 티켓. 한 행이 티켓 하나.$$;
COMMENT ON COLUMN companyx.support_tickets.client_id IS $$티켓을 올린 고객사 id(정수).$$;
COMMENT ON COLUMN companyx.support_tickets.product_id IS $$문제가 난 제품 id(정수).$$;
COMMENT ON COLUMN companyx.support_tickets.assignee_id IS $$처리 담당 직원 id(정수).$$;
COMMENT ON COLUMN companyx.support_tickets.title IS $$티켓 제목(자유 서술 문자열).$$;
COMMENT ON COLUMN companyx.support_tickets.description IS $$티켓 내용(자유 서술 문자열).$$;
COMMENT ON COLUMN companyx.support_tickets.priority IS $$우선순위(소문자 코드 넷). 긴급 = priority = 'critical', 높음 = priority = 'high', 보통 = priority = 'medium', 낮음 = priority = 'low'$$;
COMMENT ON COLUMN companyx.support_tickets.status IS $$처리 상태(코드 넷). 미해결 = status IN ('open','in_progress'), 해결 = status IN ('resolved','closed')$$;
COMMENT ON COLUMN companyx.support_tickets.created_at IS $$접수 시각(timestamp, 2024년 이후).$$;
COMMENT ON COLUMN companyx.support_tickets.resolved_at IS $$해결 시각(timestamp, 미해결이면 NULL). 처리 시간 = resolved_at - created_at$$;
