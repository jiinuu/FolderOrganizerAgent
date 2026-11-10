# Folder Organizer Agent

폴더 안의 파일을 확장자, 키워드, 이름 규칙에 따라 정리하는 로컬 데스크톱 도구입니다.

- 폴더 선택·드래그 앤 드롭과 초기 설정 안내
- 분류 규칙 설정, 처리 로그, 폴더 감시
- Electron 화면과 명령행 실행 지원

### 시작하기

Node.js 18 이상 환경에서 실행합니다.

```sh
npm install
npm run desktop
```

Windows 설치 파일은 `npm run build:win`으로 만듭니다. 명령행 사용 시 `node folder-organizer-agent.js --init-config`로 설정을 준비합니다.

**파일을 실제로 이동합니다.** [설정 예시](organizer.config.example.json)의 경로와 분류 규칙을 검토하고 `dryRun`으로 결과를 먼저 확인해주세요.

[이전 상세 문서](https://github.com/jiinuu/FolderOrganizerAgent/blob/2214f4e7fffdadd9bf2ad5c58fd05053edc58c64/README.md) — 개편 전 기록이며, 현재 안내와 다를 수 있습니다.

---

## English

A local desktop tool that organizes files using extensions, keywords, and filename rules.

- Folder selection, drag and drop, and first-run setup
- Classification settings, processing logs, and folder watching
- Electron UI and command-line support

Requires Node.js 18 or later:

```sh
npm install
npm run desktop
```

Use `npm run build:win` for a Windows installer, or `node folder-organizer-agent.js --init-config` to initialize CLI settings.

**The tool moves real files.** Review paths and rules in the [example configuration](organizer.config.example.json), and preview with `dryRun` first.

[Previous detailed documentation](https://github.com/jiinuu/FolderOrganizerAgent/blob/2214f4e7fffdadd9bf2ad5c58fd05053edc58c64/README.md) — a historical snapshot that may differ from the current guide.
