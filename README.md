# lylylyrics

유튜브/유튜브뮤직 링크를 넣으면 **시간 동기화된 가사(LRC)**를 가져와 실시간 애니메이션
타이포그래피로 보여주는 [Cotodama Lyric Speaker](https://cotodama-speaker.com/) 스타일
웹 비주얼라이저입니다. 전체화면 지원.

**▶ 라이브: https://sigmaideas.github.io/lylylyrics/**

## 동작 방식

1. 유튜브 링크 → YouTube oEmbed(백업: noembed)로 곡 제목/아티스트 추정
2. [LRCLIB](https://lrclib.net) 무료 API에서 타임스탬프 가사 조회 (API 키·백엔드 불필요)
3. YouTube IFrame 플레이어로 음원 재생 + `getCurrentTime()` 으로 가사 싱크
4. Canvas 파티클·그라데이션 배경 + 단어별 리빌 애니메이션

> 브라우저에서 유튜브 오디오를 직접 추출/음성인식하는 것은 불가능(약관·CORS)하므로,
> Cotodama처럼 **기존 동기화 가사 데이터**를 사용합니다. 세 API 모두 CORS를 허용해
> GitHub Pages 같은 정적 호스팅에서 백엔드 없이 동작합니다. 가사가 없으면 추상 비주얼
> (instrumental) 모드로 전환됩니다.

## 사용법

1. 입력창에 유튜브/유튜브뮤직 링크 붙여넣기
2. (가사를 못 찾으면) "곡 정보 직접 입력"에서 아티스트/제목 입력
3. **시작하기** → 우상단 ⤢ 버튼 또는 화면 더블클릭으로 전체화면

## 로컬 실행

정적 파일이라 아무 정적 서버면 됩니다.

```bash
npm run dev          # http://localhost:8080  (npx serve)
# 또는
python3 -m http.server 8080
```

## 배포 (GitHub Pages)

`main` 브랜치 루트를 Pages 소스로 설정하면 끝입니다. 별도 빌드 없음.
프로젝트 저장소(`lylylyrics`)라 `https://sigmaideas.github.io/lylylyrics/` 에서 서빙되며,
자산은 하위 경로에서도 동작하도록 상대경로로 참조합니다.

## 한계

- LRCLIB는 라인 단위 동기화(단어 단위 karaoke 아님)
- 자동 곡 매칭이 빗나갈 수 있어 수동 입력 폴백 제공
- 실제 오디오 진폭이 아니라 가사 타이밍 기반으로 비주얼 에너지를 생성
