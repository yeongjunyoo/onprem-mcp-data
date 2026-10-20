-- Chinook(음반 판매 예제 DB) 컬럼 주석, 담당자 검수본(2026-10-20). docs/connect-your-db.md 3단계의 예다.
-- comments-draft 초안의 TODO 를 뜻과 단위로 채웠다. 값 예시와 특정 질문에 맞춘 힌트는 넣지 않는다.
-- 점검 세트(chinook_check_v1.jsonl)를 쓰기 전에 고정했고, eval/results/catalog-chinook-comments.json 이 이 주석으로 잰 값이다.
-- 걸기: psql -d chinook -f eval/catalog/chinook_comments.sql
COMMENT ON TABLE public.artist IS $$아티스트(가수 또는 밴드)$$;
COMMENT ON COLUMN public.artist.name IS $$아티스트 이름(영문)$$;

COMMENT ON TABLE public.album IS $$앨범 한 장$$;
COMMENT ON COLUMN public.album.title IS $$앨범 제목(영문)$$;
COMMENT ON COLUMN public.album.artist_id IS $$이 앨범을 낸 아티스트$$;

COMMENT ON TABLE public.genre IS $$음악 장르$$;
COMMENT ON COLUMN public.genre.name IS $$장르 이름(영문)$$;

COMMENT ON TABLE public.media_type IS $$곡 파일 형식$$;
COMMENT ON COLUMN public.media_type.name IS $$파일 형식 이름$$;

COMMENT ON TABLE public.track IS $$곡 한 곡. 판매 단위다$$;
COMMENT ON COLUMN public.track.name IS $$곡 제목(영문)$$;
COMMENT ON COLUMN public.track.album_id IS $$곡이 실린 앨범$$;
COMMENT ON COLUMN public.track.media_type_id IS $$곡의 파일 형식$$;
COMMENT ON COLUMN public.track.genre_id IS $$곡의 장르$$;
COMMENT ON COLUMN public.track.composer IS $$작곡가. 비어 있을 수 있다$$;
COMMENT ON COLUMN public.track.milliseconds IS $$재생 시간, 밀리초$$;
COMMENT ON COLUMN public.track.bytes IS $$파일 크기, 바이트$$;
COMMENT ON COLUMN public.track.unit_price IS $$곡 정가, 달러$$;

COMMENT ON TABLE public.playlist IS $$재생 목록$$;
COMMENT ON COLUMN public.playlist.name IS $$재생 목록 이름$$;

COMMENT ON TABLE public.playlist_track IS $$재생 목록에 든 곡(재생 목록과 곡을 잇는 표)$$;
COMMENT ON COLUMN public.playlist_track.playlist_id IS $$재생 목록$$;
COMMENT ON COLUMN public.playlist_track.track_id IS $$재생 목록에 든 곡$$;

COMMENT ON TABLE public.employee IS $$직원 한 명$$;
COMMENT ON COLUMN public.employee.last_name IS $$성$$;
COMMENT ON COLUMN public.employee.first_name IS $$이름$$;
COMMENT ON COLUMN public.employee.title IS $$직함(영문)$$;
COMMENT ON COLUMN public.employee.reports_to IS $$보고하는 상사(직원)$$;
COMMENT ON COLUMN public.employee.hire_date IS $$입사일$$;
COMMENT ON COLUMN public.employee.city IS $$근무 도시$$;

COMMENT ON TABLE public.customer IS $$고객 한 명$$;
COMMENT ON COLUMN public.customer.first_name IS $$이름$$;
COMMENT ON COLUMN public.customer.last_name IS $$성$$;
COMMENT ON COLUMN public.customer.company IS $$소속 회사. 개인 고객이면 비어 있다$$;
COMMENT ON COLUMN public.customer.city IS $$고객이 사는 도시(영문)$$;
COMMENT ON COLUMN public.customer.country IS $$고객이 사는 나라(영문 국가명)$$;
COMMENT ON COLUMN public.customer.email IS $$이메일 주소$$;
COMMENT ON COLUMN public.customer.support_rep_id IS $$이 고객을 맡은 담당 직원$$;

COMMENT ON TABLE public.invoice IS $$송장(주문) 한 건$$;
COMMENT ON COLUMN public.invoice.customer_id IS $$주문한 고객$$;
COMMENT ON COLUMN public.invoice.invoice_date IS $$주문 시각$$;
COMMENT ON COLUMN public.invoice.billing_city IS $$청구 도시(영문)$$;
COMMENT ON COLUMN public.invoice.billing_country IS $$청구 나라(영문 국가명)$$;
COMMENT ON COLUMN public.invoice.total IS $$송장 합계 금액, 달러. 매출은 이 열의 합이다$$;

COMMENT ON TABLE public.invoice_line IS $$송장의 품목 한 줄(곡 하나)$$;
COMMENT ON COLUMN public.invoice_line.invoice_id IS $$이 품목이 든 송장$$;
COMMENT ON COLUMN public.invoice_line.track_id IS $$팔린 곡$$;
COMMENT ON COLUMN public.invoice_line.unit_price IS $$판매 단가, 달러$$;
COMMENT ON COLUMN public.invoice_line.quantity IS $$판매 수량$$;
