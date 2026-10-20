# Chinook Korean NL-to-SQL check set, v1

> Written by a separate agent session that never saw the product code, its results, or the column comments under test, so the set measures `docs/connect-your-db.md` step 3 (comments) without being tuned to it. Gold rows and values come from the Chinook sample database (Luis Rocha, MIT License, https://github.com/lerocha/chinook-database), which is not stored in this repository. Scoring is `air-server/src/catalogcheck.ts` (Korean country names, dropped trailing zeros and whole-number tokens are handled there).

Files: `chinook_check_v1.jsonl` (this set), `chinook_comments.sql` (the reviewed column comments used for the "with comments" run; fixed before this set was written), `chinook_documents.sql` (three short notices for the document-lane check in `docs/connect-your-db.md`; not part of the scored set).

Written 2026-10-20 (KST) against the Docker PostgreSQL copy of Chinook. 24 Korean questions: 8 simple, 10 medium, 6 hard.

- `chinook_check_v1.jsonl`: one JSON object per line, UTF-8 without BOM, LF line endings. Keys in this order: `id`, `question`, `difficulty`, `gold_sql`, `gold_rows`, `must`, `note`.
- Re-run on 2026-10-20 after writing: **24 of 24 gold_sql results match `gold_rows` exactly.**

## What was used, and what was not

- Database: PostgreSQL 16.15, service `db` in `docker-compose.yml`, database `chinook`, schema `public`, 11 base tables. Only SELECT statements were run. No other database was touched.
- Schema came from `information_schema.tables` and `information_schema.columns`, plus row samples and aggregates.
- Not read: `pg_description`, `obj_description()`, `col_description()` (the column comments under test), the reviewer's comment file, and the product's code or results. A scoring script already sat in the working folder; it was not opened, so the set does not depend on how answers are scored.

## Data facts the answers rest on

All checked with SELECTs on 2026-10-20.

| topic | fact |
|---|---|
| row counts | artist 275, album 347, track 3503, genre 25, media_type 5, playlist 18, playlist_track 8715, employee 8, customer 59, invoice 412, invoice_line 2240 |
| invoice dates | 2021-01-01 to 2025-12-22, every timestamp at 00:00; 83, 83, 83, 83, 80 invoices for 2021 to 2025 |
| quantities and prices | every invoice line has quantity 1; the line price always equals the track price (0.99 or 1.99); every invoice total equals the sum of its lines; no invoice has zero lines |
| countries | stored in English (`USA`, `Brazil`, `Germany`, ...); the invoice billing country always equals the customer's country |
| video tracks | 214 tracks are video (TV episodes and similar). All 214 have no composer; 213 of them cost 1.99, and no other track does |
| artists | 71 of the 275 artists have no album |
| employees | only the three Sales Support Agents (Jane Peacock, Margaret Park, Steve Johnson) have customers; the other five have none |
| genres | `Rock` and `Rock And Roll` are separate genres; `Opera` has one track and never sold |
| playlists | several names repeat (`Music`, `Movies`, `TV Shows`, `Audiobooks`) and `90’s Music` uses a curly apostrophe; the set only uses `Grunge`, which is unique |

## How the questions were chosen

1. Profiled the tables with SELECTs, then drafted about 40 candidates across sales, customers, employees and the catalog.
2. Dropped or rewrote every candidate that had two readings:
   - Catalog-wide track questions such as "longest track", "most expensive track", "tracks with no composer" and "tracks never sold" change answer if 곡 is read as music only, because the 214 video tracks move them. Track questions were kept only where videos cannot move the answer (C16, C21, C24) or were scoped to `Rock`, which has no video (C18).
   - Top-N with a tie at the cut-off: top 3 countries by customer count (Brazil and France tie at 5) and top 5 customers by spend (tie at 45.62).
   - "Who bought the most" by count: 58 of the 59 customers have 7 invoices, so C13 asks by amount.
   - "판매량" next to a genre could mean the genre's volume or the artist's, so C21 says "판매 수량 1위 아티스트랑 그 수량".
3. Every top-N or ranking gold_sql uses `rank()`, so a tie at the cut would show up as an extra row. The runner-up for each is in the table below.
4. Each answer was cross-checked with a second query written another way (last column below).
5. A build script ran every gold_sql and wrote the file only if the result equalled the rows recorded by hand during exploration. A separate verify script then read the written file and re-ran every gold_sql (see Verification).

## `must` conventions

- Names exactly as stored, accents included (`Helena Holý`, `François Tremblay`, `Luís Gonçalves`). People are written `First Last`.
- Countries exactly as stored (`USA`, `Canada`, `Brazil`, `France`, `Germany`). An answer that only says 미국 will not contain `USA`; the scorer has to decide whether Korean country names count.
- Numbers as plain digits with no thousands separator and no currency sign. Money keeps the two stored decimals (`2328.60`, `190.10`, `197.20`), percentages have one decimal because the question asks for one, counts are integers. Strip `,` and `$` from an answer before matching. Accepting a dropped trailing zero (`2328.6` for `2328.60`) avoids false misses.
- Per-group questions list the group label, then its value(s), group by group. A value can repeat (`91` in C21; `Jane Peacock` and `Margaret Park` in C23).
- Every `must` string appears verbatim as a cell of that question's `gold_rows` (the verify script checks this).
- Short numbers (`6`, `10`, `13`, `18`) can match by accident inside longer numbers; matching on token boundaries is safer than a plain substring test.

## Questions

| id | diff. | question | gold answer | cut-off / runner-up | cross-check |
|---|---|---|---|---|---|
| C01 | simple | 고객이 전부 몇 명이에요? | 59 | n/a | distinct customers on invoices = 59 |
| C02 | simple | 미국 고객은 몇 명이에요? | 13 | n/a | distinct invoice customers billed to USA = 13 |
| C03 | simple | 전체 매출 합계가 얼마예요? | 2328.60 | n/a | sum of line price x quantity = 2328.60 |
| C04 | simple | 주문 한 건 금액 중에 제일 큰 게 얼마예요? | 25.86 | 2nd invoice 23.86 | max of per-invoice line sums = 25.86 |
| C05 | simple | 주문 한 건당 평균 금액이 얼마예요? | 5.65 | n/a | sum / count = 5.65 |
| C06 | simple | 등록된 아티스트는 모두 몇 팀이에요? | 275 | 204 if only artists with albums | count distinct artist id = 275 |
| C07 | simple | 직원 중에 나이가 제일 많은 사람이 누구예요? | Margaret Park | 2nd Nancy Edwards (1958-12-08) | order by birth date, limit 2 |
| C08 | simple | 소속 회사가 입력돼 있는 고객은 몇 명이에요? | 10 | 49 NULL, 0 empty strings | count(company) = 10 |
| C09 | medium | 2023년 매출이 얼마예요? | 469.58 | n/a | line-level sum with year = 2023 |
| C10 | medium | 2022년 1월 매출 얼마였어요? | 52.62 | n/a | to_char(date, 'YYYY-MM') = '2022-01' |
| C11 | medium | 브라질 고객들 구매 금액 합계가 얼마예요? | 190.10 | n/a | billing country = 'Brazil' |
| C12 | medium | 매출이 제일 많은 나라 3곳이랑 나라별 매출 알려주세요. | USA 523.06, Canada 303.96, France 195.10 | 4th Brazil 190.10 | grouped by customer country |
| C13 | medium | 구매 금액이 제일 큰 고객 3명이 누구고 각각 얼마예요? | Helena Holý 49.62, Richard Cunningham 47.62, Luis Rojas 46.62 | 4th tie at 45.62 (Hugh O'Reilly, Ladislav Kovács) | line-level sums per customer |
| C14 | medium | 직원별로 담당 고객이 몇 명씩이에요? | Jane Peacock 21, Margaret Park 20, Steve Johnson 18 | other five employees 0 | customers grouped by support rep id |
| C15 | medium | Michael Mitchell 밑에서 일하는 직원은 누구예요? | Robert King, Laura Callahan | n/a | reports-to = Mitchell's id |
| C16 | medium | 곡이 제일 많은 장르 3개랑 장르별 곡 수 알려주세요. | Rock 1297, Latin 579, Metal 374 | 4th Alternative & Punk 332 | tracks grouped by genre id |
| C17 | medium | 앨범을 제일 많이 낸 아티스트는 누구고 몇 장이에요? | Iron Maiden 21 | 2nd Led Zeppelin 14 | albums grouped by artist id |
| C18 | medium | Rock 곡 중에 한 번도 안 팔린 곡은 몇 곡이에요? | 552 | 558 if `LIKE '%Rock%'` adds Rock And Roll | 1297 Rock tracks minus 745 sold; NOT IN form = 552 |
| C19 | hard | 영업 담당자별로 담당 고객 매출이 전체 매출의 몇 %인지 소수점 첫째 자리까지 알려주세요. | Jane Peacock 35.8, Margaret Park 33.3, Steve Johnson 30.9 | unrounded 35.77, 33.30, 30.93 | line-level sums by support rep id |
| C20 | hard | 매출이 제일 높은 아티스트 3팀이랑 각각 매출액 알려주세요. | Iron Maiden 138.60, U2 105.93, Metallica 90.09 | 4th Led Zeppelin 86.13 | sum of track price over sold lines |
| C21 | hard | 제일 많이 팔린 장르 3개에서 장르별 판매 수량 1위 아티스트랑 그 수량 알려주세요. | Rock: U2 91; Latin: Os Paralamas Do Sucesso 45; Metal: Metallica 91 | 4th genre Alternative & Punk 244; 2nd artists Led Zeppelin 87, Chico Buarque 27, Iron Maiden 70 | DISTINCT ON form and row_number form |
| C22 | hard | 고객이 제일 많은 나라 5곳에서 나라마다 구매 금액 1위 고객이 누구예요? | USA: Richard Cunningham; Canada: François Tremblay; Brazil: Luís Gonçalves; France: Isabelle Mercier; Germany: Fynn Zimmermann | 6th country United Kingdom (3 customers); each leader is ahead by at least 1.00 | row_number per country |
| C23 | hard | 연도별 매출 1위 영업 담당자가 누구고, 그해 담당 고객 매출이 얼마였어요? | 2021 Steve Johnson 164.34; 2022 Jane Peacock 221.92; 2023 Jane Peacock 184.34; 2024 Margaret Park 197.20; 2025 Margaret Park 168.30 | 2nd each year 161.37, 136.77, 159.47, 146.60, 156.43 | line-level sums by year and support rep id |
| C24 | hard | Grunge 재생목록에 곡이 제일 많이 들어간 아티스트는 누구고 몇 곡이에요? | Nirvana 6 | 2nd Pearl Jam 4 | playlist id 16 directly |

Spread: sales C03 to C05, C09 to C13, C19 to C21, C23; customers C01, C02, C08, C11, C13, C22; employees C07, C14, C15, C19, C23; catalog C06, C16 to C18, C20, C21, C24. Korean country names are tested in C02 (미국 → USA) and C11 (브라질 → Brazil).

## Verification

One gold_sql, by hand, in Git Bash:

```bash
docker compose -f "docker-compose.yml" exec -T db psql -U postgres -d chinook -At -F '|' -c "<gold_sql>"
```

The whole file, in Git Bash, with the script below saved as `verify_qset.py`:

```bash
python -I verify_qset.py eval/catalog/chinook_check_v1.jsonl
```

`verify_qset.py` runs the same psql command for each gold_sql (as an argument list, so no shell quoting), splits the output on `|`, compares it with `gold_rows`, and also checks the key order, LF-only line endings, the final newline, that each gold_sql starts with SELECT or WITH, and that every `must` string is a cell of `gold_rows`. No result value contains `|`, so the split is unambiguous.

```python
"""Re-run every gold_sql in a question-set JSONL and compare with gold_rows.

Usage: python -I verify_qset.py <path-to-jsonl>
"""
import json
import subprocess
import sys

COMPOSE = "docker-compose.yml"
KEYS = ["id", "question", "difficulty", "gold_sql", "gold_rows", "must", "note"]


def run_sql(sql):
    cmd = ["docker", "compose", "-f", COMPOSE, "exec", "-T", "db", "psql",
           "-U", "postgres", "-d", "chinook", "-At", "-F", "|", "-c", sql]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.run(cmd, capture_output=True, creationflags=flags)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace"))
    return [line.split("|") for line in p.stdout.decode("utf-8").splitlines() if line != ""]


def main(path):
    raw = open(path, "rb").read()
    assert b"\r" not in raw, "file has CR characters"
    lines = raw.decode("utf-8").split("\n")
    assert lines[-1] == "", "file must end with a newline"
    items = [json.loads(l) for l in lines[:-1]]
    matched = 0
    for it in items:
        assert list(it.keys()) == KEYS, it["id"]
        assert it["gold_sql"].lstrip().upper().startswith(("SELECT", "WITH")), it["id"]
        cells = {c for row in it["gold_rows"] for c in row}
        missing = [m for m in it["must"] if m not in cells]
        rows = run_sql(it["gold_sql"])
        same = rows == it["gold_rows"]
        matched += same
        print("%s %-6s rows=%d %s%s" % (it["id"], it["difficulty"], len(rows),
                                         "MATCH" if same else "MISMATCH " + repr(rows),
                                         (" must-not-in-rows=" + repr(missing)) if missing else ""))
    print("matched %d/%d" % (matched, len(items)))
    return 0 if matched == len(items) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

Output on 2026-10-20:

```
C01 simple rows=1 MATCH
C02 simple rows=1 MATCH
C03 simple rows=1 MATCH
C04 simple rows=1 MATCH
C05 simple rows=1 MATCH
C06 simple rows=1 MATCH
C07 simple rows=1 MATCH
C08 simple rows=1 MATCH
C09 medium rows=1 MATCH
C10 medium rows=1 MATCH
C11 medium rows=1 MATCH
C12 medium rows=3 MATCH
C13 medium rows=3 MATCH
C14 medium rows=3 MATCH
C15 medium rows=2 MATCH
C16 medium rows=3 MATCH
C17 medium rows=1 MATCH
C18 medium rows=1 MATCH
C19 hard   rows=3 MATCH
C20 hard   rows=3 MATCH
C21 hard   rows=3 MATCH
C22 hard   rows=5 MATCH
C23 hard   rows=5 MATCH
C24 hard   rows=1 MATCH
matched 24/24
```

## Known soft spots

- Countries in `must` are the stored English names (C12, C22). A Korean answer that writes only 미국 or 브라질 fails those strings even when it is right.
- Money values ending in 0 (`2328.60`, `190.10`, `195.10`, `138.60`, `197.20`, `168.30`) may be printed as `2328.6` and so on.
- C14 and C19 say 직원별 / 영업 담당자별. The gold uses an inner join (three people with customers); an answer that also lists the other five employees with 0 is still right and still contains every `must` value.
- C06 counts all 275 artist rows, including names that are TV shows (for example `Lost`, `The Office`), because nothing in the data separates them from musicians.
