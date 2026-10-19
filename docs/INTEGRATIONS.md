# 외부 연동 조사 (구글 클래스룸 · 구글 Tasks · Teams)

조사일: 2026-10-19. API 사실은 구글 공식 Discovery 문서(classroom v1, tasks v1)에서 직접 확인했다.
Microsoft 쪽은 공식 문서에 접속하지 못해 2차 자료와 기존 지식에 기대고 있으니, 실제로 붙이기 전에 다시 확인한다.

## 한눈에 보기

| 연동 | 가져올 것 | 가능 여부 | 막힐 수 있는 지점 |
|---|---|---|---|
| Classroom (개인 계정) | 과제명, 마감 날짜·시각, 제출 여부 | 가능 | 거의 없음 |
| Classroom (학교 계정) | 같음 | 학교 관리자 설정에 달림 | 만 18세 미만 학생 계정은 등록 안 된 외부 앱이 기본 차단 |
| Google Tasks (개인 계정) | 할 일 제목, 날짜, 완료 | 가능 | 시각은 API로 못 읽음(날짜만) |
| Teams 과제 (학교 계정) | 과제명, 마감 시각 | 학교 관리자 동의가 필요할 가능성 높음 | 관리자 동의, 학교가 Teams 과제 기능을 쓰는지 |

## 1. 구글 클래스룸

**방식.** 브라우저에서 Google Identity Services(GIS)로 로그인해 access token을 받고, Classroom REST API를 직접 부른다. 서버는 필요 없다.

**순서.**
1. `GET https://classroom.googleapis.com/v1/courses?studentId=me&courseStates=ACTIVE` 로 수강 중인 수업 목록
2. 수업마다 `GET /v1/courses/{courseId}/courseWork?courseWorkStates=PUBLISHED` 로 과제 목록
3. 수업마다 `GET /v1/courses/{courseId}/courseWork/-/studentSubmissions?userId=me` 로 내 제출 상태 (`-`는 그 수업의 모든 과제라는 뜻)
4. 제출 상태가 `TURNED_IN` 또는 `RETURNED`인 과제는 목록에서 빼거나 완료로 표시

**쓰는 필드.**
- `title`: 과제명
- `dueDate` + `dueTime`: 마감. 둘 다 **UTC 기준**이라 한국 시각(UTC+9)으로 바꿔야 한다. 예: `dueDate 2026-10-19`, `dueTime 14:59` → 한국 시각 10월 19일 23:59
- `alternateLink`: 클래스룸에서 그 과제를 여는 링크
- 제출 상태 `state`: `NEW`, `CREATED`, `TURNED_IN`, `RETURNED`, `RECLAIMED_BY_STUDENT`

**필요한 권한(scope).** 읽기 전용만 쓴다.
- `https://www.googleapis.com/auth/classroom.courses.readonly`
- `https://www.googleapis.com/auth/classroom.coursework.me.readonly`

**계정 두 개.** GIS 토큰 요청을 계정마다 따로 한다(`login_hint`에 이메일을 넣으면 그 계정으로 바로 간다). 토큰도 계정별로 따로 들고 있는다.
이메일 주소는 코드에 박아 두지 않고 연결할 때 입력받는다. 레포가 public이 되면 코드가 모두 공개되기 때문이다.

### 학교 계정(sshs.hs.kr)에서 막힐 수 있는 이유

학교 계정은 학교가 관리하는 Google Workspace for Education 계정이다. 구글 정책상
**만 18세 미만으로 지정된 학생 계정은 관리자가 따로 허용하지 않은 외부 앱(unconfigured third-party apps)에 로그인할 수 없다.**
막히면 `access_not_configured` 오류가 나고, 학생 화면에 관리자에게 접근을 요청하는 버튼이 뜬다.
관리자가 Admin console → 보안 → API 제어 → 검토 대기 중인 앱에서 허용해야 쓸 수 있다.

이 앱이 학교 계정에서 될지는 **직접 로그인해 봐야 안다.** 학교가 이 설정을 어떻게 해 두었는지 알 수 없기 때문이다.
막히면 고를 수 있는 방법:
- 정보부장 선생님이나 학교 관리자에게 앱 허용을 요청한다
- 학교 클래스룸 알림 메일이 개인 Gmail로 오게 해 두고, 개인 계정 쪽에서 메일을 읽어 과제를 뽑는다(정확도가 떨어지고 범위가 커서 마지막 수단)

## 2. 구글 Tasks

- 목록: `GET https://tasks.googleapis.com/tasks/v1/users/@me/lists`
- 할 일: `GET /tasks/v1/lists/{tasklist}/tasks?showCompleted=false`
- 완료 처리: `PATCH /tasks/v1/lists/{tasklist}/tasks/{task}` 에 `status: "completed"`
- scope: `https://www.googleapis.com/auth/tasks` (완료 체크까지 하려면 읽기 전용이 아닌 이 권한)

**제약.** Tasks API 문서에 '날짜 정보만 기록되고 시각은 버려진다. API로 시각을 읽거나 쓸 수 없다'고 적혀 있다.
구글 Tasks 앱에서 시각을 넣어 둔 할 일도 API로는 날짜만 온다. 그래서 오른쪽 목록에서는 그날 마감으로 보고 정렬하고, 시간표 위의 마감선으로는 그리지 않는다.

## 3. Teams (학교 계정)

**방식.** Microsoft Graph의 Education API. 브라우저에서 MSAL.js로 로그인해 토큰을 받는다.
- 과제 목록: `GET https://graph.microsoft.com/v1.0/education/me/assignments`
- 마감 시각: 과제의 `dueDateTime` (UTC)
- 권한: `EduAssignments.ReadBasic` (위임 권한, 성적 없이 과제만 읽기)

**확인된 것과 확인 못 한 것.**
- 이 권한은 회사·학교 계정 전용이고 개인 Microsoft 계정은 지원하지 않는다고 나와 있다.
- 2차 자료(권한 목록 사이트)에는 이 권한이 **관리자 동의 필요**로 표시되어 있다. 공식 문서로 다시 확인해야 한다. 맞다면 학교 Microsoft 365 관리자가 앱을 승인해야 쓸 수 있다.
- 학교가 Teams의 과제(Assignments) 기능으로 과제를 내는지도 확인이 필요하다. Teams를 채팅이나 수업 링크로만 쓰면 가져올 과제가 없다.
- 학교 Microsoft 계정의 아이디가 구글 학교 계정과 같은 주소인지 모른다. 연결할 때 확인한다.

## 4. 준비 작업(사용자가 할 일)

### 구글 (Classroom + Tasks 공통, 한 번만)
1. https://console.cloud.google.com 에서 새 프로젝트 만들기 (개인 계정으로)
2. API 및 서비스 → 라이브러리에서 **Google Classroom API**, **Google Tasks API** 사용 설정
3. OAuth 동의 화면: 사용자 유형 '외부', 게시 상태 '테스트'. 테스트 사용자에 개인 계정과 학교 계정을 둘 다 추가
4. 사용자 인증 정보 → OAuth 클라이언트 ID → 유형 '웹 애플리케이션'. 승인된 JavaScript 원본에
   - `https://yoo677.github.io` (GitHub Pages 주소)
   - `http://localhost:8000` (내 컴퓨터에서 시험할 때)
5. 만들어진 클라이언트 ID(…apps.googleusercontent.com)를 알려 주면 코드에 넣는다. 클라이언트 ID는 공개되어도 되는 값이다(비밀 키 아님)

테스트 모드라 구글 심사는 필요 없다. 대신 로그인할 때 '확인되지 않은 앱' 경고가 뜨고, 고급 → 계속을 누르면 된다.

### Microsoft (Teams)
1. https://entra.microsoft.com 에서 앱 등록(학교 계정으로 로그인이 안 되면 개인 Microsoft 계정으로 만들고 '모든 조직 디렉터리의 계정' 선택)
2. 플랫폼: 단일 페이지 애플리케이션(SPA), 리디렉션 URI에 GitHub Pages 주소
3. API 권한에 Microsoft Graph 위임 권한 `EduAssignments.ReadBasic` 추가
4. 학교 계정으로 로그인했을 때 관리자 승인이 필요하다고 나오면, 학교 관리자에게 요청해야 한다

## 5. 앱 쪽 연결 지점

`sources.js`의 `Sources.setItems(source, items)`로 항목을 넣으면 오른쪽 목록, 달력 칸, 하루 시간표의 마감선에 바로 반영된다.
항목 형식은 `sources.js` 맨 위 주석에 있다. 연동 코드는 `google.js`, `microsoft.js`로 따로 만들어 이 함수만 부르게 할 예정이다.
