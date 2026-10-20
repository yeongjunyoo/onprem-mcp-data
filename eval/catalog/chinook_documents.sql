-- Chinook 에 문서 레인을 붙여 본 안내문 3건(2026-10-20). docs/connect-your-db.md 「문서 레인과 그래프 레인」의 예다.
-- 본문은 이 저장소에서 쓴 것이고 Chinook 원본에는 없다. 걸기: psql -d chinook -f eval/catalog/chinook_documents.sql
-- 그다음 air-server 에서 DATASET=catalog CATALOG_SCHEMA=public 그대로 npm run embed 로 embedding 열을 채운다.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE public.documents (id serial PRIMARY KEY, title text NOT NULL, body text NOT NULL, embedding vector(1024));
INSERT INTO public.documents (title, body) VALUES
 ('환불 정책', '구매한 곡은 내려받지 않았다면 구매일로부터 7일 안에 환불을 신청할 수 있다. 한 번이라도 내려받은 곡은 환불되지 않는다. 환불액은 결제한 수단으로 3영업일 안에 돌아간다.'),
 ('파일 형식 안내', '곡은 MPEG 오디오와 AAC 오디오 두 형식으로 판다. 보호된 AAC 파일은 구매한 계정에서만 재생된다. 동영상은 MPEG-4 형식이다.'),
 ('고객 지원 운영 시간', '고객 지원은 평일 오전 9시부터 오후 6시까지 받는다. 담당 지원 직원이 정해진 고객은 그 직원에게 먼저 연결된다.');
