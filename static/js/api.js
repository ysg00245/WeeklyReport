// ═══════════════════════════════════════
//  API 유틸
// ═══════════════════════════════════════
const API = '';  // 같은 origin이므로 빈 문자열

/** URL ?team= 파라미터에서 팀 slug 읽기. 없으면 'default' */
function getTeamSlug() {
  return new URLSearchParams(window.location.search).get('team') || 'default';
}

/** localStorage에서 세션 토큰 읽기 */
function getAuthToken() {
  return localStorage.getItem('wr_token') || '';
}

async function api(path, opts = {}) {
  const token = getAuthToken();
  const requestToken = token;
  const headers = {
    'Content-Type': 'application/json',
    'X-Team-Slug': getTeamSlug(),
    ...(token ? { 'X-Auth-Token': token } : {}),
    ...opts.headers,
  };
  const res = await fetch(API + path, { headers, cache: 'no-store', ...opts });

  // 로그인 시도 자체의 401(PIN/비밀번호 틀림)은 '세션 만료'가 아니다 —
  // 전역 세션 정리·화면 리셋을 타면 PIN 화면이 초기화되어 오류 안내가 사라지므로, 호출부(catch)가 처리하도록 그대로 던진다.
  if (res.status === 401 && (path.startsWith('/api/auth/login') || path.startsWith('/api/admin/login'))) {
    const err = await res.json().catch(() => ({ detail: '인증에 실패했습니다' }));
    throw new Error(err.detail || '인증에 실패했습니다');
  }

  // 세션 만료 → 로컬 토큰/세션 + 메모리 상태 + 헤더까지 완전 정리 후 로그인 화면으로
  // (localStorage 만 지우고 메모리/헤더를 안 지우면 "헤더엔 로그인됨, 화면은 로그인" 불일치 발생)
  if (res.status === 401) {
    const currentToken = getAuthToken();
    // 로그인/로그아웃 전환 중에 이전 요청이 늦게 401을 받는 경우가 있다.
    // 이때 현재 새 토큰을 지우면 방금 로그인한 세션까지 튕기므로, 요청 당시 토큰과 현재 토큰이 다르면 무시한다.
    if ((requestToken && currentToken && requestToken !== currentToken) ||
        (!requestToken && currentToken)) {
      const err = await res.json().catch(() => ({ detail: '이전 세션 요청이 만료되었습니다' }));
      throw new Error(err.detail || '이전 세션 요청이 만료되었습니다');
    }

    localStorage.removeItem('wr_token');
    localStorage.removeItem('wr_user');
    localStorage.removeItem('wr_user_ts');
    localStorage.removeItem('wr_is_admin');
    localStorage.removeItem('wr_admin_token');
    localStorage.removeItem('wr_sysadmin_token');
    // 메모리 세션 상태 초기화
    user = null; isAdmin = false; isSysAdmin = false; isApprover = false; isDivAdmin = false;
    try {
      document.body.classList.remove('logged-in', 'approver-mode');
    } catch (_) {}
    if (typeof updateHeaderSessions === 'function') updateHeaderSessions();
    if (typeof showPage === 'function') showPage('pgLogin');
    const err = await res.json().catch(() => ({ detail: '세션이 만료되었습니다. 다시 로그인해주세요' }));
    throw new Error(err.detail || '세션 만료');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    // FastAPI 422 검증 오류는 detail 이 배열/객체 → 그대로 Error 에 넣으면 "[object Object]" 로 표시됨
    let detail = err.detail || err.message || '요청 실패';
    if (typeof detail !== 'string') {
      try {
        detail = Array.isArray(detail)
          ? detail.map(d => d && d.msg ? d.msg : JSON.stringify(d)).join(' / ')
          : JSON.stringify(detail);
      } catch (_) { detail = '요청 실패'; }
    }
    throw new Error(detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ═══════════════════════════════════════
let user = null;     // { name, role }
let isAdmin = false;
let isSysAdmin = false;
let isApprover = false;   // 결재권자(팀장/주간보고 담당자)가 본인 PIN 으로 로그인한 세션 — 결재권자 경량뷰 노출
let isDivAdmin = false;   // 그룹장 세션 — 본부 관리자 비밀번호 로그인 (멤버 등록 불필요)
let members = [];    // [{ id, name, role, created_at }]

// 현재 user 가 결재권자(=팀장)인지 — 팀장만 PIN 로그인 시 결재권자 콘솔로 진입.
// 주간보고 담당자(report_admin)는 일반 팀원처럼 작성폼 → 콘솔은 기존 관리자(admin_pw) 로그인으로 분리.
function memberIsApprover(name) {
  const m = (members || []).find(x => x.name === name);
  return !!(m && m.is_leader);
}
// 그룹장(상위조직장) — divisions.head_name 매칭. PIN 로그인 시 그룹 보고 현황 콘솔로 진입.
function memberIsDivisionHead(name) {
  const m = (members || []).find(x => x.name === name);
  return !!(m && m.is_division_head);
}
let weekMode = 0;    // 0=연도주차, 1=월주차


let globalSettings = { locations_schema: [], projects_schema: [], roles_schema: [] };
let loadStep = 0;
const totalSteps = 3;

function updateLoadProgress(txt) {
  loadStep++;
  const p = Math.min((loadStep / totalSteps) * 100, 100);
  document.getElementById('initProgBar').style.width = p + '%';
  if(txt) document.getElementById('initLoadTxt').textContent = txt;
}

function showActionLoader(txt) {
  document.getElementById('actionLoadTxt').textContent = txt || '처리 중...';
  document.getElementById('actionLoader').classList.add('show');
}
function hideActionLoader() {
  document.getElementById('actionLoader').classList.remove('show');
}

async function loadSettings() {
  try {
    globalSettings = await api('/api/settings');
    applySettingsToUI();
  } catch(e) {
    console.error('설정 로드 실패:', e);
    throw new Error('서버 통신 오류 (설정 데이터를 불러올 수 없습니다)');
  }
}

function applySettingsToUI() {
  // 프로젝트 선택 폼 동적 구성
  const projSel = document.getElementById('newMemberProject');
  if (projSel) {
    projSel.innerHTML = '<option value="">프로젝트 선택</option>' + 
      (globalSettings.projects_schema || []).map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
  // 프로젝트 ROLE 폼 동적 구성 (addMember 용 초기화는 handled by updateAddMemberPRoles)
}

// members 가 인증 상태(X-Auth-Token 동반 → PIN 정보 포함)로 로드됐는지.
// 비인증 부트스트랩 데이터를 관리자 콘솔(PIN 표 필요)이 그대로 재사용하는 사고 방지용.
let _membersAuthed = false;

async function loadMembers() {
  try {
    members = await api('/api/members');
    _membersAuthed = !!getAuthToken();
    populateLoginSel();
  } catch (e) {
    members = [];
    console.error('팀원 로드 실패:', e);
    throw new Error(`서버 통신 오류 (${orgLabel('member')} 데이터를 불러올 수 없습니다)`);
  }
}
