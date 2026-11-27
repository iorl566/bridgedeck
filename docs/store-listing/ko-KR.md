# BridgeDeck — ko-KR store listing

Locale: `ko-KR` (package locale `ko`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/ko/messages.json`, read-only):
BridgeDeck은 이미 로그인된 브라우저를 AI 에이전트의 작업 공간으로 바꿉니다. 로컬 daemon + MV3 확장 프로그램, 텔레메트리 없음.

## Description

BridgeDeck은 이미 사용하고 있는 브라우저를 AI 에이전트의 작업 공간으로 바꿔 줍니다.

에이전트에 작업을 맡기면 이미 로그인된 세션을 그대로 활용해 별도의 Agent Window에서 일을 처리합니다. 무엇을 하는지 항상 보이고, 필요하면 직접 조작을 이어받거나 일시 중지, 중지할 수 있습니다.

할 수 있는 일

- 이미 로그인된 곳에서 그대로 작업합니다. 문서를 읽고, 사내 시스템을 검색하고, 본인 계정이 필요한 웹 절차를 끝까지 처리합니다.
- 지시를 브라우저 동작으로 바꿉니다. 페이지 구조 읽기, 클릭, 입력, 양식 작성, 선택, 끌어 놓기, 스크롤, 파일 업로드와 다운로드, 탭 관리를 지원합니다.
- 통제권은 계속 사용자에게 있습니다. 눈에 보이는 제어 카드, 조작 중인 페이지를 감싸는 파란색 호흡 테두리, 언제든 쓸 수 있는 일시 중지와 중지, 그리고 사용자의 탭을 빌리기 전에 표시되는 확인 창이 있습니다.
- 웹 데이터를 그대로 가져옵니다. 표와 목록을 JSON 또는 CSV로 추출하고, 열 이름과 각 값이 어느 페이지나 프레임에서 왔는지도 함께 남깁니다.
- 실패의 근거를 찾아냅니다. 요청, 응답 본문, 콘솔 메시지, 페이지 변화, 성능 소요 시간, 중복 요청 점검 결과를 JSON으로 내보낼 수 있습니다.
- 작업 과정을 다시 볼 수 있습니다. 승인한 작업 탭 하나를 무음 MP4로 녹화하고, 확장 프로그램 안에서 미리 보기, 저장, 삭제를 할 수 있습니다.
- 긴 페이지도 저장합니다. 자동 스크롤, 수동 이어 붙이기, 보이는 영역만 캡처하는 방식 중에서 고를 수 있습니다.
- 기록을 남깁니다. 선택형 작업 감사, 작업 기록, 증거가 모두 로컬에 저장됩니다.

에이전트를 위해 설계했습니다

CLI 하나, MCP 서버(도구 92개), DeepSeek Harness 플러그인(도구 37개), 그리고 Node.js와 Python SDK를 제공합니다. 셸 명령을 실행할 수 있는 에이전트라면 무엇이든 브라우저를 조작할 수 있으며, 특정 모델이나 공급업체에 묶이지 않습니다.

기본은 로컬, 기본은 프라이빗

- 127.0.0.1의 로컬 daemon에 연결합니다. 클라우드 서비스도, 텔레메트리도 없습니다.
- 원격 페어링은 선택 사항이며 항상 인증된 WSS를 사용합니다. 페어링하지 않은 로컬 연결도 동작하지만 신원 확인 경고가 표시됩니다.
- 스크린샷, 녹화, 디버깅 증거, 감사 기록은 모두 사용자의 컴퓨터에 남습니다.
- 확장 프로그램은 스스로 AI 공급자를 호출하지 않습니다.

필요한 환경

- Microsoft Edge, Google Chrome 또는 기타 Chromium 기반 브라우저, 버전 111 이상.
- 로컬 daemon과 CLI를 위해서는 Node.js 20 이상이 필요합니다.
- daemon은 Windows, macOS, Linux에서 실행됩니다. Windows에는 그래픽 설치 프로그램이 있고, macOS와 Linux에서는 install.sh가 포함된 tar.gz 압축 파일을 사용합니다.

시작하기

확장 프로그램을 설치하고 팝업을 열어 "연결됨"이 표시되는지 확인하세요. bridge 명령을 처음 실행하면 daemon이 자동으로 시작됩니다.

소스 코드, CLI 설치 안내, 문서: https://github.com/iorl566/bridgedeck

개인정보 처리방침 안내: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- 브라우저 자동화
- AI 에이전트
- 브라우저 제어
- 웹 스크래핑
- 페이지 읽기
- MCP 서버
- Edge 확장 프로그램

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/ko/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
