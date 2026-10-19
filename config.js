// 외부 연동 설정. 클라이언트 ID는 비밀 값이 아니어서 공개 레포에 올려도 된다.
window.APP_CONFIG = {
  // Google Cloud Console → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID (…apps.googleusercontent.com)
  googleClientId: '1026894356688-kfsajvuamdju9i3k815j1pqplc5rkjgf.apps.googleusercontent.com',

  // Microsoft Entra → 앱 등록 → 개요의 '애플리케이션(클라이언트) ID'와 '디렉터리(테넌트) ID'
  microsoftClientId: '',
  microsoftTenantId: '',
};
