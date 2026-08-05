# Premiere Link Import — 설계 문서

- 날짜: 2026-08-05
- 목적: 개인 편집용. YouTube/Instagram/TikTok 링크를 Premiere Pro 패널에서 바로 다운로드해 프로젝트에 임포트하는 CEP 확장.
- 범위: MVP (링크 붙여넣기 → 다운로드 → 자동 임포트). 검색, I/O 구간 자르기, 트랙 자동 삽입은 이번 범위 밖.

## 배경

참고 제품(litt.ly의 "Link Import")은 Premiere 패널 안에서 URL 검색/붙여넣기 → 다운로드 → 코덱 변환 → 트랙 삽입 → 빈(bin) 정리까지 처리하는 유료 CEP 확장. 이번 작업은 그 핵심 가치(패널 밖으로 안 나가고 레퍼런스 영상을 바로 가져오는 것)만 개인 사용 목적으로 구현한다. 판매/배포 목적이 아니므로 라이선스, 설치 패키징, 서명(ZXP)은 다루지 않는다.

## 환경 전제

- macOS, Adobe Premiere Pro 2026 설치됨
- `ffmpeg`, `yt-dlp`가 Homebrew로 이미 설치되어 PATH에 존재 (`/opt/homebrew/bin/ffmpeg`, `/opt/homebrew/bin/yt-dlp`)
- Node.js v24 설치됨 (CEP 패널의 Node 통합에 사용)

## 아키텍처

CEP(Common Extensibility Platform) 확장으로 구현한다. 이유:
- Premiere Pro의 표준 패널 확장 방식이며 문서/커뮤니티 자료가 풍부함
- CSInterface의 Node.js 통합(`enableNodeJS`)으로 패널 JS에서 `child_process`를 통해 로컬 CLI(`yt-dlp`, `ffmpeg`)를 직접 실행 가능
- ExtendScript(JSX)로 Premiere의 프로젝트 DOM(`app.project`)을 조작해 빈 생성 및 파일 임포트 가능

대안으로 검토했으나 기각한 방식:
- **UXP**: Premiere Pro의 UXP 지원이 아직 제한적이고, child_process 같은 로컬 프로세스 실행이 까다로움
- **독립 Electron 앱 + Watch Folder**: 기술은 단순하지만 "패널 안에서 끝난다"는 핵심 가치가 사라짐

### 디렉터리 구조

```
premiere-link-import/
├── CSXS/manifest.xml       # 확장 메타데이터, Premiere 버전 요구사항
├── index.html               # 패널 UI
├── css/style.css
├── js/main.js               # UI 로직 + child_process로 yt-dlp/ffmpeg 실행
├── jsx/hostscript.jsx        # ExtendScript: 빈 생성/파일 임포트
└── icons/
```

## 컴포넌트별 상세

### 1. 패널 UI (index.html + css/style.css)

- URL 입력창 1개
- 화질 선택 드롭다운: 4K / FHD(기본값) / HD
- "가져오기" 버튼
- 진행 상태 텍스트: 다운로드 중(%) → 병합 중 → 임포트 완료 / 에러
- 최근 가져온 항목 리스트 (파일명 + 임포트 시각, 세션 내 메모리 유지, 영속 저장 없음)

### 2. 다운로드 로직 (js/main.js)

입력 및 검증:
- URL이 비어있거나 `youtube.com`/`youtu.be`/`instagram.com`/`tiktok.com` 도메인이 아니면 즉시 에러 표시, 프로세스 실행 안 함

다운로드 대상 경로:
- 활성 Premiere 프로젝트의 `.prproj` 파일 위치를 ExtendScript(`app.project.path`)로 조회
- `<프로젝트폴더>/00_LinkImport/` 하위에 저장 (폴더 없으면 생성)
- 프로젝트가 저장되지 않은 상태(경로 없음)면 에러 표시 후 중단 ("프로젝트를 먼저 저장해주세요")

yt-dlp 포맷 문자열 (품질별):
- HD: `bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]`
- FHD (기본): `bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]`
- 4K: `bv*[height<=2160]+ba/b`

실행 커맨드 패턴:
```
yt-dlp -f "<포맷문자열>" --merge-output-format mp4 \
  --restrict-filenames \
  -o "<프로젝트폴더>/00_LinkImport/%(title)s.%(ext)s" \
  --newline <url>
```
- `--restrict-filenames`로 제목에 포함될 수 있는 특수문자/공백을 안전한 문자로 치환 (경로 깨짐, ExtendScript 문자열 이스케이프 문제 예방)
- `--newline`으로 진행률을 줄 단위로 파싱해 패널에 `%` 표시
- yt-dlp가 PATH의 ffmpeg를 자동 감지해 비디오+오디오 병합 처리 (별도 변환 스텝 불필요)
- 프로세스 종료 코드가 0이 아니면 stderr 내용을 에러 메시지로 패널에 표시
- 완료 시 다운로드된 실제 파일 경로(yt-dlp 출력 로그에서 파싱, 확장자는 `%(ext)s`가 `mp4`로 고정되므로 예측 가능)를 확보

### 3. Premiere 연동 (jsx/hostscript.jsx)

두 개의 ExtendScript 함수를 노출하고 `CSInterface.evalScript()`로 호출:

- `getProjectFolderPath()`: `app.project.path`를 반환. 프로젝트가 저장 안 된 상태면 빈 문자열 반환
- `importToLinkImportBin(filePath)`:
  1. `app.project.rootItem`의 자식 중 이름이 "00_LinkImport"인 빈이 있는지 확인
  2. 없으면 `app.project.rootItem.createBin("00_LinkImport")`로 생성
  3. `app.project.importFiles([filePath], false, targetBin, false)`로 해당 빈에 임포트
  4. 성공/실패 여부를 문자열로 반환 (JS 쪽에서 파싱)

### 4. 설치 (개인용, 서명/패키징 불필요)

1. `premiere-link-import/` 폴더를 통째로 `~/Library/Application Support/Adobe/CEP/extensions/`에 복사
2. 설치된 Premiere Pro 2026의 CSXS 버전 확인 후 디버그 모드 활성화:
   ```
   defaults write com.adobe.CSXS.<버전> PlayerDebugMode 1
   ```
3. Premiere Pro 재시작 → 창(Window) → 확장명(Extensions) → Link Import

## 에러 처리

| 상황 | 처리 |
|---|---|
| URL 비어있음/지원 안 하는 도메인 | 즉시 에러, 프로세스 실행 안 함 |
| 프로젝트 저장 안 됨 (경로 없음) | "프로젝트를 먼저 저장해주세요" 에러 |
| yt-dlp 실행 실패 (네트워크, 삭제된 영상 등) | stderr 메시지를 패널에 표시 |
| yt-dlp/ffmpeg PATH에 없음 | 시작 시 `which` 체크, 없으면 패널에 설치 안내 문구 표시 |
| ExtendScript 임포트 실패 | evalScript 반환값 확인 후 에러 표시 |

## 테스트 전략

- Node 쪽 순수 로직(URL 도메인 검증, 품질별 포맷 문자열 생성, yt-dlp stdout 진행률 파싱)은 별도 모듈로 분리해 단위 테스트 작성 (Node 내장 `node:test` 사용, 별도 프레임워크 의존성 추가 안 함)
- ExtendScript ↔ Premiere DOM 연동은 자동화 테스트 대상이 아님 (Adobe ExtendScript는 표준 테스트 러너 지원 안 함) → 실제 Premiere Pro 2026에서 수동 실행으로 검증하고 스크린샷/로그로 증명

## 범위 밖 (다음 버전 후보)

- 패널 내 유튜브 검색 (썸네일 표시)
- I/O 단축키로 구간만 잘라 다운로드
- 다운로드 완료 후 플레이헤드 위치의 지정 트랙에 자동 삽입
- Windows 지원
