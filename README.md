# NOL 티켓 캘린더

NOL World와 국내 NOL의 콘서트·뮤지컬·스포츠·전시 일정을 보여주는 캘린더입니다.
GitHub Actions가 매일 오전 6시쯤(한국 시간) 목록을 새로 읽어 GitHub Pages에 올립니다.

- `site/index.html` 캘린더 화면
- `site/events.json` 일정 데이터 (자동 갱신)
- `scripts/update.mjs` 수집 스크립트
- `data/names-ko.json` 국내 NOL 한국어 이름 캐시 (자동 갱신)
- `.github/workflows/update.yml` 매일 실행 설정

수동으로 갱신하려면 Actions 탭 → Update calendar → Run workflow를 누르세요.
