# Folder Organizer Agent

비개발자도 쓸 수 있는 로컬 폴더 자동 정리 프로그램입니다.

- 방식 1: GUI에서 폴더 선택 버튼 클릭
- 방식 2: 폴더 드래그앤드롭

지정한 폴더 하위 파일이 자동 분류되어 `organizedRoot`로 이동됩니다.
결과 폴더를 비워두면 대상 폴더와 같은 위치에 `대상폴더명_organized_by_agent`가 자동 생성됩니다.

## 주요 기능

- 첫 실행 3단계 마법사(폴더 선택 -> 결과 폴더 선택 -> 실행 옵션)
- 다음 실행부터 빠른 시작 홈 화면
- 폴더 선택 UI
- 드래그앤드롭으로 경로 지정
- 시작/중지 버튼
- 설정 저장/불러오기
- 빠른 시작 버튼(다음 실행부터 1클릭 시작)
- 앱 시작 시 자동 시작 옵션
- 실행 로그 표시
- 새 파일 유입 시 자동 정리(상시 실행)
- 확장자/키워드 규칙 + 기존 정리 패턴 학습

## 로컬 실행 (개발/테스트)

사전 준비:

- Node.js 18+

설치:

```bash
npm install
```

GUI 실행:

```bash
npm run desktop
```

## Windows 배포(.exe)

```bash
npm run build:win
```

빌드 결과물은 `dist/` 폴더에 생성됩니다.

설치 시 자동 생성:

- 바탕화면 바로가기
- 시작 메뉴 바로가기

커스텀 아이콘(선택):

1. 기본 아이콘은 `desktop/icon.ico`로 이미 포함되어 있습니다.
2. 원하는 아이콘으로 교체하려면 `desktop/icon.ico`를 덮어쓰기 하면 됩니다.
3. 원본 템플릿은 `desktop/icon-template.svg`를 참고하세요.

## CLI도 사용 가능

```bash
node folder-organizer-agent.js --init-config
node folder-organizer-agent.js --config organizer.config.json
node folder-organizer-agent.js --config organizer.config.json --once
```

## 파일 구성

- `desktop/main.js`: Electron 메인 프로세스
- `desktop/preload.js`: 안전한 IPC 브리지
- `desktop/renderer.html`: GUI 화면
- `desktop/renderer.js`: 버튼/드래그앤드롭/로그 처리
- `folder-organizer-agent.js`: 실제 파일 정리 엔진
- `organizer.config.example.json`: 설정 예시

## 주의

- 정리는 실제 파일 이동 작업입니다.
- 처음에는 GUI에서 `dry-run` 옵션으로 시뮬레이션 후 실제 적용을 권장합니다.
