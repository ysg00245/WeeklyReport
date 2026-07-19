// ═══════════════════════════════════════
//  앱 메타 (버전 / 세션 정책)
// ═══════════════════════════════════════
// 메이저(2.x → 3.x)가 바뀌면 모든 세션 강제 만료 + 강제 새로고침.
// 마이너/패치 변경은 세션 유지.
const APP_VER = '3.2.1';
const SESSION_MAX_AGE_DAYS = 7;

// 개발기 배너 (localhost 접속 시만 표시)
(function showDevBanner() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.') || h === '') {
    const el = document.getElementById('devBanner');
    if (el) el.style.display = '';
  }
})();

// ── 신기능 안내 (버전별, 변경 시 1회 노출) ──
// audience 옵션 (생략 시 'all'):
//   'all'          — 모든 사용자 (비로그인 포함)
//   'member'       — 로그인한 일반 팀원 (관리자 제외)
//   'admin'        — 팀 관리자 or 시스템 관리자
//   'system_admin' — 시스템 관리자 전용
//   배열로 OR 결합 가능: ['admin', 'system_admin']
const APP_VER_NOTES = {
  '2.1.0': {
    audience: 'all',
    title: '✨ 새 기능: 모바일 앱 설치 + 푸시 알림',
    sub: '환경설정에서 홈 화면에 앱으로 설치하고, 마감/보완요청 알림을 받아보세요',
    cta: { text: '⚙️ 설정 열기', action: 'openSettings' },
  },
  '2.2.0': {
    audience: 'all',
    title: '📲 홈 화면에 앱으로 추가해보세요!',
    sub: '모바일에서 바로 앱처럼 열고, 마감·보완 요청 알림도 받을 수 있어요',
    cta: { text: '지금 설치하기', action: 'showInstallPromo' },
  },
  // ⚠️ 이 객체는 모듈 로드 시점에 평가된다 — orgLabel() 을 직접 부르면 서버 호칭이 오기 전이라
  //    항상 기본값('팀')으로 굳는다. 호칭은 {team} 토큰으로 쓰고 렌더 시 fillOrgLabels() 가 치환한다.
  '2.3.0': {
    audience: 'admin',
    title: '🏢 멀티{team} 지원이 추가되었습니다',
    sub: 'URL에 {team} 정보가 포함됩니다. {member}에게는 ?team=slug URL을 공유해주세요',
    cta: null,
  },
  '3.0.0': {
    audience: 'admin',   // 관리자 전용 — 일반 구성원에게는 노출되지 않음
    title: '🏢 v3.0 — {division}/{team} 계층 + 시스템 관리자 콘솔',
    sub: '{division}/{team} 조직도가 반영되었습니다. 주간보고 관리자(정/부) 지정 시 로그인 1회 안내 + 푸시 재발송 지원.',
    cta: null,
  },
  '3.1.0': {
    audience: 'admin',   // 관리자/결재권자 대상 — 일반 구성원 화면 변화는 크지 않음
    title: '📋 v3.1 — 계층 보고: 최종 취합 → 보고 → 결재',
    sub: '결재권자가 최종 취합본을 [보고]하면 상위 조직장이 열람·승인·보완요청할 수 있어요. 보완요청은 실시간 알림으로 전달됩니다.',
    cta: null,
  },
  '3.2.0': {
    audience: 'all',
    title: '⚡ v3.2 — 더 빠르게, 더 정확하게',
    sub: '첫 화면 로딩이 빨라지고, 보완요청·결재 실시간 알림이 로그인 직후부터 안정적으로 도착합니다. 결재 상태는 화면 상단에서 바로 확인하세요.',
    cta: null,
  },
};

// 시스템 관리자 콘솔 배너 카드에서 코드 기본값 목록을 보여주기 위해 window 노출
window.APP_VER_NOTES = APP_VER_NOTES;
window.APP_VER = APP_VER;

// 로그인 화면 하단 버전 표기 — 하드코딩하면 배포마다 갱신을 잊는다(실제로 v3.1.0 로 굳어 있었음)
(function stampAppVersion() {
  const paint = () => document.querySelectorAll('.app-ver').forEach(el => { el.textContent = 'v' + APP_VER; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();

// 현재 사용자가 배너 노출 대상에 해당하는지 판정
// - audience 가 안 맞으면 배너 노출 안 함 + wr_seen_ver 마킹도 안 함
//   (권한 변경 시 다음 진입에서 볼 수 있도록)
// 주의: isAdmin/isSysAdmin 은 api.js 의 `let` 변수라 window.* 로 접근 불가 → 직접 식별자 참조
function _audienceMatches(audience) {
  if (!audience || audience === 'all') return true;
  const list = Array.isArray(audience) ? audience : [audience];
  const _isSys = (typeof isSysAdmin !== 'undefined' && isSysAdmin === true);
  const _isAdm = (typeof isAdmin    !== 'undefined' && isAdmin    === true);
  const _hasUser = (typeof user !== 'undefined' && !!user);
  const _isMember = _hasUser && !_isAdm && !_isSys;
  for (const a of list) {
    if (a === 'all') return true;
    if (a === 'system_admin' && _isSys) return true;
    if (a === 'admin' && (_isAdm || _isSys)) return true;
    if (a === 'member' && _isMember) return true;
  }
  return false;
}

function _majorOf(v) { return (v || '0').split('.')[0]; }

(function migrateSessionByVersion() {
  try {
    const saved = localStorage.getItem('wr_app_ver');
    if (saved && _majorOf(saved) !== _majorOf(APP_VER)) {
      // 메이저 변경 → 모든 세션 클리어 + 캐시 버스트 새로고침
      const keys = ['wr_user', 'wr_is_admin', 'wr_user_ts', 'wr_cur_page', 'wr_token'];
      keys.forEach(k => localStorage.removeItem(k));
      localStorage.setItem('wr_app_ver', APP_VER);
      // 한 번만 강제 새로고침 (이미 ?v=...가 있으면 그대로 두고 단순 reload)
      if (!sessionStorage.getItem('_wr_major_reloaded')) {
        sessionStorage.setItem('_wr_major_reloaded', '1');
        location.replace(location.pathname + '?upgrade=' + Date.now());
      }
      return;
    }
    if (!saved) localStorage.setItem('wr_app_ver', APP_VER);

    // 7일 만료
    const ts = parseInt(localStorage.getItem('wr_user_ts') || '0', 10);
    if (ts && Date.now() - ts > SESSION_MAX_AGE_DAYS * 86400000) {
      localStorage.removeItem('wr_user');
      localStorage.removeItem('wr_is_admin');
      localStorage.removeItem('wr_user_ts');
      localStorage.removeItem('wr_token');
    }
  } catch (e) { console.warn('session migration:', e); }
})();

// ═══════════════════════════════════════
//  초기화
// ═══════════════════════════════════════
// ── 팀 선택 화면으로 이동 ──
function goToTeamSelect() {
  location.href = '/';
}

// 랜딩 설정 캐시 (showTeamSelectPage / window.onload / brand-sub IIFE / doLogout 공유)
let _landingCache = null;
let _landingPromise = null;   // 동시 호출 dedup — 같은 순간 여러 곳(pwa 등)에서 불려도 fetch 1회
async function _getLanding() {
  if (_landingCache) return _landingCache;
  if (_landingPromise) return _landingPromise;
  _landingPromise = (async () => {
    try {
      // 부트스트랩(landing 포함)이 날아가는 중이면 그 응답을 기다렸다 재사용 — 중복 왕복 방지
      if (window._bootLandingPromise) {
        try { await window._bootLandingPromise; } catch (_) {}
        if (_landingCache) return _landingCache;
      }
      _landingCache = await fetch('/api/settings/landing-config', { cache: 'no-store' }).then(r => r.json());
      // 조직 호칭 적용 (본부/팀/팀원 → 그룹/유닛/구성원 등)
      if (_landingCache && _landingCache.org_labels && typeof setOrgLabels === 'function') setOrgLabels(_landingCache.org_labels);
      if (_landingCache && _landingCache.brand && typeof setBrand === 'function') setBrand(_landingCache.brand);
    } catch (_) { _landingCache = null; }
    return _landingCache;
  })();
  _landingPromise.finally(() => { _landingPromise = null; });
  return _landingPromise;
}
// 다른 모듈(auth.js 등)에서도 사용
window._getLanding = _getLanding;

// ── 팀 선택 랜딩 ──
async function showTeamSelectPage() {
  // 즉시 picker 페이지 뼈대 노출 → 카드는 fetch 후 채움 (체감 latency 제거)
  const grid = document.getElementById('teamList');
  if (grid && !grid.dataset.loaded) {
    grid.innerHTML = `
      <div style="padding:30px 20px;text-align:center;color:var(--text2)">
        <div style="display:inline-block;width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--brand-500);border-radius:50%;animation:sa-rotate .8s linear infinite"></div>
        <div style="margin-top:10px;font-size:13px">${orgLabel('team')} 목록을 불러오는 중...</div>
      </div>`;
  }
  showPage('pgTeamSelect');
  // 로딩 화면 숨기기
  document.getElementById('initLoader').classList.add('hide');

  // 통합 랜딩 설정 — 1회만 fetch (teams / divisions 도 동봉됨)
  const landing = await _getLanding();
  const defaultSlug = (landing && landing.default_team_slug) || 'default';
  const mtOn = !!(landing && landing.multi_team_enabled);

  // 멀티팀 OFF — 항상 기본팀으로 강제 진입 (이전 wr_last_team 캐시 무시)
  // 이전: 마지막 방문 팀 우선 → 멀티팀 켰다 끄면 옛 팀으로 가는 버그
  if (!mtOn) {
    localStorage.setItem('wr_last_team', defaultSlug);
    location.replace('?team=' + encodeURIComponent(defaultSlug));
    return;
  }

  // 멀티팀 ON — 자동 진입 없이 picker 강제 표시
  // (wr_last_team / wr_user 무시. 사용자가 ?team=xxx URL 로 직접 진입하는 경우엔 그 팀으로 가도록 window.onload 가 처리)
  let teams = (landing && Array.isArray(landing.teams)) ? landing.teams.slice() : [];
  let divisions = (landing && Array.isArray(landing.divisions)) ? landing.divisions.slice() : [];

  // 화이트리스트 OR 결합: 본부 체크 시 그 본부 하위 팀 자동 포함 + 명시적으로 체크된 팀 추가 포함
  const visTeamIds = new Set((landing.visible_team_ids     || []).map(Number));
  const visDivIds  = new Set((landing.visible_division_ids || []).map(Number));
  const hasTeamFilter = visTeamIds.size > 0;
  const hasDivFilter  = visDivIds.size > 0;
  if (hasTeamFilter || hasDivFilter) {
    teams = teams.filter(t =>
      (hasDivFilter && t.division_id != null && visDivIds.has(Number(t.division_id))) ||
      (hasTeamFilter && visTeamIds.has(Number(t.id)))
    );
    // 헤더로 노출할 본부도 자동 조정 (실제 표시 팀이 포함된 본부만)
    const usedDivIds = new Set(teams.map(t => t.division_id).filter(x => x != null));
    divisions = divisions.filter(d => usedDivIds.has(d.id));
  }

  // 노출 가능 팀이 1개뿐이면 바로 이동
  if (teams.length === 1) {
    location.replace('?team=' + encodeURIComponent(teams[0].slug));
    return;
  }

  // 팀 선택 카드 렌더 — HTML id 는 'teamList' (vertical list 컨테이너)
  // (위에서 이미 const grid 선언 — 재선언 시 SyntaxError 발생하므로 그대로 재사용)
  if (!grid) return;
  if (teams.length === 0) {
    grid.innerHTML = `<p style="color:var(--text2);font-size:13px;text-align:center;padding:20px">노출된 ${olj('team','이')} 없습니다.<br>시스템 관리자에게 문의해주세요.</p>`;
  } else {
    // 본부별 그룹핑 (선택 화이트리스트 적용 후)
    const divsMap = new Map((divisions || []).map(d => [d.id, d]));
    const grouped = new Map();
    teams.forEach(t => {
      const key = t.division_id || 0;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(t);
    });
    // 본부 순으로 정렬
    const ordered = [];
    (divisions || []).forEach(d => {
      if (grouped.has(d.id)) ordered.push({ id: d.id, name: d.name, head_name: d.head_name || '', teams: grouped.get(d.id) });
    });
    if (grouped.has(0)) ordered.push({ id: 0, name: orgLabel('division') + ' 미지정', teams: grouped.get(0) });

    grid.innerHTML = ordered.map(g => `
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:var(--text2);font-weight:700;padding:4px 6px;margin-bottom:6px;border-left:3px solid var(--brand-500);padding-left:10px">${esc(g.name)}</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${g.teams.slice().sort((a, b) =>
            ((b.slug || '').startsWith('divhq-') ? 1 : 0) - ((a.slug || '').startsWith('divhq-') ? 1 : 0)
          ).map(t => {
            // divhq-* = 그룹에 직접 속한 인원(유닛 미소속). 인원 수에 따라 표기가 갈린다:
            //   1명(보통 그룹장만) → 팀으로 감싸지 않고 '사람 카드'로 노출, 클릭 시 그 사람 PIN 직행
            //   2명 이상(그룹장 + 직속/대기 인원) → 일반 유닛과 동일하게 '소속 카드' + 구성원 선택 화면
            const isHq = (t.slug || '').startsWith('divhq-');
            const hqSolo = isHq && (t.member_count == null || t.member_count <= 1);
            if (isHq && hqSolo && !g.head_name) return '';
            const title = hqSolo ? g.head_name
                                 : (isHq ? `${g.name} 직속` : t.name);
            const sub   = hqSolo ? orgLabel('division_head')
                                 : (isHq ? (g.head_name ? `${orgLabel('division_head')} ${g.head_name} · ${t.member_count}명` : `${t.member_count}명`)
                                         : (t.leader_name ? `${orgLabel('leader')} ${t.leader_name}` : ''));
            const onclick = hqSolo
              ? `selectTeamFromPicker('${esc(t.slug)}','${esc(g.head_name)}')`
              : `selectTeamFromPicker('${esc(t.slug)}')`;
            return `
            <button class="team-pick-card" onclick="${onclick}"
                    style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;text-align:left;transition:background .15s,border-color .15s">
              <div class="ava" style="width:36px;height:36px;border-radius:${hqSolo ? '50%' : '8px'};background:linear-gradient(135deg,${isHq ? 'var(--ai-1),var(--brand-600)' : 'var(--brand-400),var(--brand-700)'});color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${esc((title || '?').charAt(0))}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:700;color:var(--text)">${esc(title)}</div>
                ${sub ? `<div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(sub)}</div>` : ''}
              </div>
              <span style="color:var(--text2);font-size:14px">›</span>
            </button>`; }).join('')}
        </div>
      </div>`).join('');
  }

  // 시스템 관리자 세션이 살아있으면 picker 하단에 콘솔 진입 버튼 노출
  const sysToken = localStorage.getItem('wr_sysadmin_token');
  const sysSlot = document.getElementById('teamPickerSysAdminSlot');
  if (sysSlot) {
    if (sysToken) {
      sysSlot.style.display = '';
      sysSlot.innerHTML = `
        <button onclick="enterSysAdminFromPicker()"
                style="margin-top:14px;width:100%;padding:10px 14px;border:1px dashed var(--brand-500);border-radius:10px;background:color-mix(in oklab, var(--brand-500) 6%, transparent);color:var(--brand-500);cursor:pointer;font-weight:600;font-size:13px">
          🛠️ 시스템 관리자 콘솔로 이동
        </button>`;
    } else {
      sysSlot.style.display = 'none';
      sysSlot.innerHTML = '';
    }
  }

  // 페이지 표시
  showPage('pgTeamSelect');
}

// picker 에서 팀 카드 클릭 — 관리자 세션 모두 정리하고 일반 팀원으로 진입
// autoMember: picker 에서 '사람' 항목(그룹장 등)으로 진입 — 도착 페이지의 표준 로그인 화면이
// 구성원 선택 단계를 건너뛰고 그 사람의 표준 PIN 단계부터 시작한다 (A-2 확정 흐름).
function selectTeamFromPicker(slug, autoMember) {
  // 즉시 로딩 피드백 (페이지 전환 전 빈 화면 체감 제거) — 새 페이지 진입 시 initLoader 가 이어받음
  if (typeof showActionLoader === 'function') showActionLoader('이동 중...');
  try {
    localStorage.removeItem('wr_sysadmin_token');
    localStorage.removeItem('wr_is_admin');
    localStorage.removeItem('wr_token');
    // wr_user(_ts)까지 정리해야 토큰 없는 '좀비 세션' 복원을 막는다.
    // (안 지우면 새 팀 진입 시 onload 가 옛 user 를 복원 → 토큰 부재로 API 401 →
    //  api() 가 렌더 도중 user=null 로 바꿔 'reading name of null' 간헐 오류 발생)
    localStorage.removeItem('wr_user');
    localStorage.removeItem('wr_user_ts');
  } catch (_) {}
  localStorage.setItem('wr_last_team', slug);
  try {
    if (autoMember) sessionStorage.setItem('wr_auto_member', autoMember);
    else sessionStorage.removeItem('wr_auto_member');
  } catch (_) {}
  location.href = '?team=' + encodeURIComponent(slug);
}

// picker 에서 "🛠️ 시스템 관리자 콘솔로" 클릭 — 그 자리에서 sysadmin 화면으로
// (wr_last_team 이 없을 때 하드코딩 'default' 로 보내면, 그 slug 팀이 없는 멀티팀 DB에선
//  onload 의 invalid-slug 처리로 picker 에 되튕겨 '무반응'처럼 보이던 버그 → 실존 팀으로 fallback)
async function enterSysAdminFromPicker() {
  if (typeof showActionLoader === 'function') showActionLoader('시스템 관리자 콘솔 여는 중...');
  let slug = localStorage.getItem('wr_last_team');
  try {
    const landing = await _getLanding();
    const teams = (landing && landing.teams) || [];
    if (!slug || !teams.some(t => t.slug === slug)) {
      slug = (landing && landing.default_team_slug && teams.some(t => t.slug === landing.default_team_slug))
        ? landing.default_team_slug
        : (teams[0] && teams[0].slug);
    }
  } catch (_) {}
  if (!slug) {
    if (typeof hideActionLoader === 'function') hideActionLoader();
    toast(`진입할 ${olj('team','이')} 없습니다. ${olj('team','을')} 먼저 생성해주세요.`, 'err');
    return;
  }
  location.href = '?team=' + encodeURIComponent(slug);
}

window.onload = async () => {
  // ── 팀 파라미터 체크 ──
  const teamSlug = new URLSearchParams(location.search).get('team');
  if (!teamSlug) {
    // URL에 ?team= 없을 때 (예: iPhone PWA start_url='/' 로 홈화면 아이콘 재실행).
    // 저장된 관리자/시스템관리자 세션이 있으면 마지막 팀 컨텍스트로 복원해 정상 세션 복구 경로
    // (아래 gotoAdmin/gotoSysAdmin)를 태운다. 이게 없으면 picker 로 떨어지고, 팀 카드를 누르면
    // selectTeamFromPicker 가 관리자 토큰을 지워서 일반 팀원 로그인 화면에 갇히는 버그가 있었다.
    // (일반 팀원은 기존대로 picker 강제 표시 — 팀 전환 UX 보존)
    const _savedAdmin = localStorage.getItem('wr_is_admin') === 'true';
    const _savedSys   = !!localStorage.getItem('wr_sysadmin_token');
    const _lastTeam   = localStorage.getItem('wr_last_team');
    if ((_savedAdmin || _savedSys) && _lastTeam) {
      location.replace('?team=' + encodeURIComponent(_lastTeam));
      return;
    }
    // URL에 ?team= 없으면 팀 선택 화면으로
    await showTeamSelectPage();
    return;
  }

  // ── 32차: 부트스트랩 선발사 ──
  // landing + settings + members 를 한 왕복으로 확보. 아래 슬러그 검증과 try 블록의
  // 구성 로드가 이 응답 하나를 공유한다. 실패(구서버·네트워크) 시 null → 각자 기존 경로 폴백.
  const _bootPromise = api('/api/settings/bootstrap').then(b => {
    if (b && b.landing) {
      _landingCache = b.landing;   // _getLanding() 캐시 선주입 (슬러그 검증·brand-sub IIFE 공유)
      if (b.landing.org_labels && typeof setOrgLabels === 'function') setOrgLabels(b.landing.org_labels);
        if (b.landing.brand && typeof setBrand === 'function') setBrand(b.landing.brand);
    }
    return b;
  }).catch(() => null);
  window._bootLandingPromise = _bootPromise;   // _getLanding() 이 중복 fetch 대신 이 응답을 기다리게
  // 콜드스타트 UX — Neon autosuspend 후 첫 요청은 깨우는 데 수 초 걸린다.
  // 2.5초 넘게 걸리면 "느린 게 아니라 깨우는 중" 안내로 체감 개선 (구조상 없앨 수 없는 지연).
  const _coldTimer = setTimeout(() => {
    if (typeof updateLoadProgress === 'function') {
      updateLoadProgress('☁️ 절전 중인 서버를 깨우는 중... 잠시만 기다려주세요');
    }
  }, 2500);
  _bootPromise.finally(() => clearTimeout(_coldTimer));

  // ?team=<slug> 검증
  try {
    const _b0 = await _bootPromise;
    const landing = (_b0 && _b0.landing) || await _getLanding();
    const defaultSlug = (landing && landing.default_team_slug) || 'default';
    const teamsAll = (landing && landing.teams) || [];
    const cur = teamsAll.find(t => t.slug === teamSlug);

    // 1) 존재하지 않는 slug — 멀티팀 ON 이면 picker(/), OFF 면 default 팀으로 즉시 조용히 redirect.
    //    (옛 동작: 2.5초 에러 화면 노출 → UX 별로. landing-config 자동 fallback 까지 있어서 default 도 항상 valid.)
    if (!cur) {
      try { localStorage.removeItem('wr_last_team'); } catch (_) {}
      if (landing && landing.multi_team_enabled) {
        location.replace('/');
      } else {
        location.replace('?team=' + encodeURIComponent(defaultSlug));
      }
      return;
    }

    if (landing && landing.multi_team_enabled) {
      // 멀티팀 ON: 화이트리스트 OR 결합 검증
      const visTeamIds = new Set((landing.visible_team_ids || []).map(Number));
      const visDivIds  = new Set((landing.visible_division_ids || []).map(Number));
      const hasTeam = visTeamIds.size > 0;
      const hasDiv  = visDivIds.size > 0;
      if (hasTeam || hasDiv) {
        const visible = (hasDiv && cur.division_id != null && visDivIds.has(Number(cur.division_id))) ||
                        (hasTeam && visTeamIds.has(Number(cur.id)));
        if (!visible) {
          try { localStorage.removeItem('wr_last_team'); } catch (_) {}
          location.replace('/');
          return;
        }
      }
    } else {
      // 멀티팀 OFF: 기본팀이 아닌 ?team=<slug> 진입 시도 → 차단
      if (teamSlug !== defaultSlug) {
        if (typeof showSystemError === 'function') {
          showSystemError(`멀티${orgLabel('team')} 기능이 비활성화되어 있습니다.\n"${teamSlug}" ${orgLabel('team')}에는 접근할 수 없습니다.\n\n잠시 후 기본 ${orgLabel('team')}(${defaultSlug})으로 이동합니다.`);
        }
        setTimeout(() => {
          localStorage.setItem('wr_last_team', defaultSlug);
          location.replace('?team=' + encodeURIComponent(defaultSlug));
        }, 2500);
        return;
      }
    }
  } catch (_) { /* landing-config 실패해도 그대로 진행 */ }

  // 방문한 팀 slug 저장 (다음에 루트(/) 접속 시 자동 리다이렉트용)
  localStorage.setItem('wr_last_team', teamSlug);

  // 테마 및 주차 설정 초기화 (로컬)
  const th = localStorage.getItem('wr_theme') || 'light';
  document.documentElement.setAttribute('data-theme', th);
  applyThemeIcon(th);
  weekMode = parseInt(localStorage.getItem('wr_wmode') || '0');
  updateWeekChip();

  // NOTE: 팀 선택 랜딩(?team= 없을 때)은 위쪽 showTeamSelectPage() 에서 이미 처리됐다.
  //       머지 시 워크트리 쪽 중복 블록이 들어왔던 부분을 제거.

  // 팀 이름을 로그인 화면 브랜드 영역에 반영
  //  + 멀티팀 ON 이고 노출 가능 팀이 2개 이상일 때만 "팀 선택 화면으로" 이스터에그 활성화
  (async () => {
    const el = document.getElementById('loginBrandSub');
    if (!el) return;
    const landing = await _getLanding();
    const teams = (landing && landing.teams) || [];

    const found = (teams || []).find(t => t.slug === teamSlug);
    if (found && found.name) {
      el.textContent = found.name + ' · 주간보고';
      document.title = found.name + ' 주간보고';
    }

    // 이스터에그 활성화 조건: 멀티팀 ON + 노출 가능 팀 2개 이상
    const mtOn = !!(landing && landing.multi_team_enabled);
    const visIds = new Set(((landing && landing.visible_team_ids) || []).map(Number));
    const visibleTeams = visIds.size > 0
      ? (teams || []).filter(t => visIds.has(Number(t.id)))
      : (teams || []);
    const easterEggOn = mtOn && visibleTeams.length >= 2;

    if (easterEggOn) {
      el.style.cursor = 'pointer';
      el.title = `${orgLabel('team')} 선택 화면으로`;
      el.onclick = () => { location.href = '/'; };
      el.onmouseenter = () => { el.style.opacity = '.6'; };
      el.onmouseleave = () => { el.style.opacity = '1'; };
    } else {
      el.style.cursor = 'default';
      el.removeAttribute('title');
      el.onclick = null;
      el.onmouseenter = null;
      el.onmouseleave = null;
    }
  })();

  try {
    // 1 & 2. 부트스트랩 1회 호출로 landing + settings + members 확보 (32차 최적화)
    //   기존: landing-config / settings / members = DB 왕복 3회(각 ~1.3s)
    //   현재: /api/settings/bootstrap 1회. 실패 시 기존 개별 호출로 폴백해 하위호환 유지.
    updateLoadProgress('시스템 구성 요소 로드 중...');
    let booted = false;
    {
      const b = await _bootPromise;   // 위에서 선발사한 응답 재사용 (landing 은 이미 캐시 주입됨)
      if (b && b.settings && Array.isArray(b.members)) {
        globalSettings = b.settings;
        applySettingsToUI();
        members = b.members;
        _membersAuthed = !!getAuthToken();   // 세션복원 부팅이면 PIN 정보 포함 상태
        populateLoginSel();
        booted = true;
        updateLoadProgress('구성 데이터 로드 완료...');
      }
    }
    if (!booted) {
      await Promise.all([
        loadSettings().then(() => updateLoadProgress('양식 설정 동기화 완료...')),
        loadMembers().then(() => updateLoadProgress(`${orgLabel('member')} 명부 확인 완료...`))
      ]);
    }

    // 3. 세션 복구 및 권한 데이터 로드
    populateAdminWeekSel();
    setupWebSocket();

    const savedSysAdmin = !!localStorage.getItem('wr_sysadmin_token');
    const savedAdmin = (localStorage.getItem('wr_is_admin') === 'true');
    const savedUserStr = localStorage.getItem('wr_user');

    if (savedSysAdmin) {
      isSysAdmin = true;
      user = null;
      localStorage.removeItem('wr_user');
      await gotoSysAdmin();
    } else if (savedAdmin) {
      isAdmin = true;
      user = null;
      localStorage.removeItem('wr_user');
      await gotoAdmin();
    } else if (savedUserStr) {
      isAdmin = false;
      user = JSON.parse(savedUserStr);
      document.body.classList.add('logged-in');

      // 그룹장(상위조직장) — picker 인라인 로그인 직후 진입 포함, 복원 시 그룹장 콘솔로 직행
      if (typeof memberIsDivisionHead === 'function' && memberIsDivisionHead(user.name) && typeof gotoDivisionHead === 'function') {
        await gotoDivisionHead();
        Promise.all([fetchUserPermissions(), renderWriteForm(), updateBanner()]).catch(() => {});
      } else
      // 결재권자(팀장/주간보고 담당자)면 새로고침/재진입 시에도 결재권자 콘솔로 복원
      if (typeof memberIsApprover === 'function' && memberIsApprover(user.name) && typeof gotoApprover === 'function') {
        await gotoApprover();
        Promise.all([fetchUserPermissions(), renderWriteForm(), updateBanner()]).catch(() => {});
      } else {
        isApprover = false;
        if (typeof _exitApvUserHeader === 'function') _exitApvUserHeader();
        showPage('pgUser');
        // 사용자 필수 데이터 병렬 로드
        await Promise.all([
          fetchUserPermissions(),
          renderWriteForm(),
          updateBanner()
        ]);
        // PWA standalone 으로 진입한 기존 로그인 사용자 — 알림 권한 자동 요청 (1회)
        if (typeof autoPromptNotificationIfNeeded === 'function') {
          autoPromptNotificationIfNeeded();
        }
      }
    } else {
      isAdmin = false;
      user = null;
      showPage('pgLogin');
      // A-2: picker 에서 '사람'(그룹장 등)으로 진입한 경우 — 표준 로그인 화면을 PIN 단계부터 시작.
      // showPage 의 loginGoBack() 리셋 '이후' 같은 동기 프레임에서 표준 selectLoginMember() 를
      // 호출하므로, 구성원 선택 화면은 페인트되지 않고 곧바로 표준 PIN 패드가 뜬다.
      try {
        const _auto = sessionStorage.getItem('wr_auto_member');
        if (_auto) {
          sessionStorage.removeItem('wr_auto_member');
          if ((members || []).some(m => m.name === _auto) && typeof selectLoginMember === 'function') {
            selectLoginMember(_auto);
          }
        }
      } catch (_) {}
    }

    updateHeaderSessions();
    updateLoadProgress('준비 완료!');

    // 로딩 화면 종료 (약간의 여운을 위해 지연)
    setTimeout(() => {
      document.getElementById('initLoader').classList.add('hide');
      // 신기능 안내 배너 (버전 변경 시 1회 노출)
      showVerBannerIfNeeded();
      // 모바일 설치 유도 팝업 (배너 표시 후 0.8s 뒤)
      setTimeout(() => { if (typeof showInstallPromo === 'function') showInstallPromo(); }, 800);
    }, 400);

  } catch (e) {
    console.error('Init Error:', e);
    showSystemError(e && e.message ? e.message : String(e));
  }
};

// 시스템 오류 화면 호출 (초기 로딩 실패 또는 치명적 통신 오류)
function showSystemError(detail) {
  try {
    const loader = document.getElementById('initLoader');
    if (loader) loader.classList.add('hide');
    const ov = document.getElementById('systemErrorOv');
    if (!ov) return;
    const detailEl = document.getElementById('systemErrorDetail');
    if (detailEl) {
      if (detail) {
        detailEl.textContent = String(detail).slice(0, 500);
        detailEl.style.display = '';
      } else {
        detailEl.style.display = 'none';
      }
    }
    const timeEl = document.getElementById('systemErrorTime');
    if (timeEl) {
      const now = new Date();
      timeEl.textContent = now.toLocaleString('ko-KR', { hour12: false });
    }
    ov.style.display = '';
  } catch (_) { /* 마지막 보루는 무시 */ }
}

// ── 신기능 안내 배너 (버전별 / 서버 nonce 기반 재노출 지원) ──
// 우선순위:
//   1) 서버의 banner_override 가 enabled=true 면 그 값 사용 (시스템 관리자가 편집한 내용)
//   2) 없으면 APP_VER_NOTES[APP_VER] 코드 default 사용
// 재노출 트리거:
//   - 서버 banner_nonce 가 localStorage.wr_banner_seen_nonce 와 다르면 → 강제 재노출
//   - 사용자가 닫으면 현재 nonce 저장 → 다음에 안 보임
async function showVerBannerIfNeeded() {
  // 1) 서버 배너 설정 가져오기 (실패해도 로컬 default 동작)
  //    부팅 직후 호출이라 부트스트랩이 방금 채운 landing 캐시(nonce 포함)가 최신 — 재왕복 불필요
  let landing = null;
  try {
    landing = (typeof _getLanding === 'function')
      ? await _getLanding()
      : await fetch('/api/settings/landing-config', { cache: 'no-store' }).then(r => r.json());
  } catch (_) { landing = null; }

  const override = (landing && landing.banner_override && landing.banner_override.enabled) ? landing.banner_override : null;
  const serverNonce = (landing && landing.banner_nonce) || '';

  // 2) 배너 콘텐츠 결정
  let notes;
  if (override) {
    notes = {
      title: override.title || '',
      sub:   override.sub   || '',
      audience: override.audience || 'all',
      cta: (override.cta_text ? { text: override.cta_text, action: override.cta_action || '' } : null),
    };
  } else {
    notes = APP_VER_NOTES[APP_VER];
  }
  if (!notes || (!notes.title && !notes.sub)) {
    localStorage.setItem('wr_seen_ver', APP_VER);
    return;
  }

  // 3) 노출 대상 체크 (audience)
  if (!_audienceMatches(notes.audience)) return;

  // 4) 표시 조건 — 다음 중 하나라도 만족하면 표시:
  //    (a) 같은 버전을 아직 안 봄
  //    (b) 서버 nonce 가 갱신되어 마지막 본 nonce 와 다름
  const seenVer   = localStorage.getItem('wr_seen_ver');
  const seenNonce = localStorage.getItem('wr_banner_seen_nonce') || '';
  const newVersion = (seenVer !== APP_VER);
  const newNonce   = (serverNonce && seenNonce !== serverNonce);
  if (!newVersion && !newNonce) return;   // 둘 다 본 상태 → 표시 안 함

  // 5) 렌더
  const banner = document.getElementById('verBanner');
  if (!banner) return;
  // {team}/{member} 등 호칭 토큰을 현재 조직 호칭으로 치환 (서버 배너 override 도 동일 적용)
  const _fill = (s) => (typeof fillOrgLabels === 'function' ? fillOrgLabels(s || '') : (s || ''));
  document.getElementById('vbTitle').textContent = _fill(notes.title);
  document.getElementById('vbSub').textContent   = _fill(notes.sub);
  const ctaBtn = document.getElementById('vbCta');
  if (notes.cta && notes.cta.text) {
    ctaBtn.textContent  = notes.cta.text;
    ctaBtn.style.display = '';
    banner._action = notes.cta.action;
  } else {
    ctaBtn.style.display = 'none';
    banner._action = null;
  }
  banner._currentNonce = serverNonce;   // 닫을 때 저장할 값
  banner.style.display = 'flex';
}

function onVerBannerCta() {
  const banner = document.getElementById('verBanner');
  const action = banner?._action;
  dismissVerBanner();
  if (action === 'openSettings' && typeof openSettings === 'function') {
    // 로그인 상태가 아니면 안내만
    if (!user) {
      toast('로그인 후 환경설정을 이용할 수 있습니다.', 'info');
      return;
    }
    openSettings();
  } else if (action === 'showInstallPromo' && typeof showInstallPromo === 'function') {
    setTimeout(showInstallPromo, 200);
  }
}

function dismissVerBanner() {
  localStorage.setItem('wr_seen_ver', APP_VER);
  const banner = document.getElementById('verBanner');
  if (banner) {
    // 서버 nonce 도 기록 → 같은 nonce 동안엔 재노출 안 됨 (다음 republish 시 다시 보임)
    if (banner._currentNonce) {
      localStorage.setItem('wr_banner_seen_nonce', banner._currentNonce);
    }
    banner.style.display = 'none';
  }
}

// ── WS 알림 배너 (관리자 전용) ──
// isRevision: 보완요청 → 재제출 전이일 때 true → "수정했습니다" 로 안내
// isSummaryStale: 해당 주차에 AI 요약이 이미 저장되어 있어 재요약 권장 필요 →
//   본문 sub 라인에 "♻️ AI 재요약 실행" 버튼 인라인 표시.
//   (이전엔 별도 LATE_REPORT_UPDATED 노티로 분리 표시되어 노티 2개가 떴음 — 통합)
function showWsNoti(name, weekKey, type, isRevision = false, isSummaryStale = false) {
  const container = document.getElementById('wsNotiContainer');
  if (!container) return;

  const isSubmit  = type === 'REPORT_SUBMITTED';
  const icoCls    = isSubmit ? 'submit' : 'delete';
  const icoGlyph  = isSubmit ? '✓' : '✕';
  const icoStyle  = isSubmit
    ? 'color:#22c55e;font-size:20px;font-weight:800'
    : 'color:#ef4444;font-size:18px;font-weight:700';
  const action    = isSubmit
    ? (isRevision ? '주간보고를 수정했습니다' : '주간보고를 등록했습니다')
    : '주간보고가 삭제되었습니다';
  const weekLabel = (typeof getWeekLabel === 'function') ? getWeekLabel(weekKey) : weekKey;
  const safeKey   = String(weekKey).replace(/"/g, '&quot;');
  const resummaryBtn = isSummaryStale
    ? ` · <button class="ws-noti-link-btn" data-wk="${safeKey}" onclick="triggerAiResummary(this.dataset.wk,this)">♻️ AI 재요약 실행</button>`
    : '';

  const el = document.createElement('div');
  el.className = 'ws-noti';
  el.innerHTML = `
    <div class="ws-noti-ico ${icoCls}"><span style="${icoStyle}">${icoGlyph}</span></div>
    <div class="ws-noti-body">
      <div class="ws-noti-title">${esc(name)}님이 ${esc(action)}</div>
      <div class="ws-noti-sub">${esc(weekLabel)}${resummaryBtn}</div>
    </div>
    <button class="ws-noti-close" onclick="this.closest('.ws-noti').remove()">✕</button>`;

  container.appendChild(el);

  // 자동 dismiss — 재요약 버튼 있을 땐 클릭 시간 확보를 위해 길게 (4s → 6s)
  const dismissAfter = isSummaryStale ? 6000 : 4000;
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 380);
  }, dismissAfter);
}

// ── AI 재요약 트리거 (관리자 전용) ──
function triggerAiResummary(weekKey, btn) {
  const sel = document.getElementById('adminWeekSel');
  if (sel) sel.value = weekKey;
  if (typeof genAllSummary !== 'function') {
    toast('AI 요약 탭으로 이동 후 다시 시도해주세요.', 'warn');
    return;
  }
  const origText = btn.textContent;
  btn.textContent = '⏳ 요약 중...';
  btn.disabled = true;
  genAllSummary()
    .then(() => { btn.textContent = '✅ 완료'; })
    .catch(() => { btn.textContent = origText; btn.disabled = false; });
}

// ── WebSocket 실시간 동기화 ──
let socket;
let _wsHbTimer = null;         // heartbeat (연결 열려있는 동안만 도는 순수 소켓 ping — DB 무관)
let _wsReconnTimer = null;     // 재연결 예약
let _wsRetry = 0;              // 지수 백오프 단계
let _wsWasConnected = false;   // 재연결 구분 (재연결 시에만 화면 재동기화)
let _wsManualClose = false;    // 로그아웃 등 의도적 종료 → 재연결 금지

function setupWebSocket() {
  // 이미 연결된 소켓이 있으면 재사용
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (_wsReconnTimer) { clearTimeout(_wsReconnTimer); _wsReconnTimer = null; }
  _wsManualClose = false;

  // 토큰이 없으면 연결 생략 (비로그인 상태)
  const token = (typeof getAuthToken === 'function') ? getAuthToken() : (localStorage.getItem('wr_token') || '');
  if (!token) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    const isReconnect = _wsWasConnected;
    _wsWasConnected = true;
    _wsRetry = 0;
    // heartbeat 25초 — Render 프록시의 유휴 연결 종료 방지 + 좀비 소켓 조기 감지.
    // 서버 /ws 는 receive 루프에서 소비만 하고 DB 를 전혀 거치지 않는다 (Neon autosuspend 무관).
    if (_wsHbTimer) clearInterval(_wsHbTimer);
    _wsHbTimer = setInterval(() => {
      try { if (socket && socket.readyState === WebSocket.OPEN) socket.send('ping'); } catch (_) {}
    }, 25000);
    // 재연결이면 끊긴 동안 놓친 알림(보완요청 등)을 화면 1회 재동기화로 따라잡는다.
    // 첫 연결은 방금 초기 로드를 마친 상태라 불필요.
    if (isReconnect) _wsResyncScreens();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[WS] 수신:', data);
      
      // 팀 필터 — 전역 브로드캐스트라 필터 없으면 타 팀 이벤트까지 모든 관리자에게
      // 노티·패치가 발생한다. team_slug 없는 구서버 페이로드는 기존대로 통과(하위호환).
      const _tOk = !data.team_slug || (typeof getTeamSlug === 'function' && data.team_slug === getTeamSlug());
      // 현황 탭이 화면에 보이는지 — 안 보이면 패치 대신 dirty 처리해 탭 복귀 시 재조회
      const _dashVisible = () => {
        const dashTab = document.getElementById('tabDash');
        const pgAdmin = document.getElementById('pgAdmin');
        return pgAdmin && pgAdmin.classList.contains('active')
            && dashTab && dashTab.style.display !== 'none';
      };
      const _dashDirty = () => { if (typeof _dashRenderedWeek !== 'undefined') _dashRenderedWeek = null; };

      if (data.type === 'REPORT_SUBMITTED') {
        // 재제출 여부 판별 — patchMemberCard 가 카드를 교체하기 전 직전 배지로 결정
        // ('보완 요청' = .warning 배지) → 알림 문구를 "수정했습니다" 로 분기
        const wasNeedsRevision = !!document
          .getElementById(`srow_${data.member_name}`)
          ?.querySelector('.sr-status .badge-new.warning');
        if (isAdmin && _tOk) {
          // 대시보드 패치는 late 여부 무관하게 항상 수행. 현황 탭이 안 보이면 dirty 만.
          if (_dashVisible()) patchMemberCard(data.member_name, data.week_key);
          else _dashDirty();
          // 관리자 알림 배너 — AI 재요약 권장은 summary_stale 플래그로 인라인 표시.
          // (이전: LATE_REPORT_UPDATED 별도 노티 + is_late 가드 → 두 개 노티 발송)
          showWsNoti(data.member_name, data.week_key, 'REPORT_SUBMITTED', wasNeedsRevision, !!data.summary_stale);
        }
      } else if (data.type === 'REPORT_STATUS_CHANGED') {
        // 관리자 대시보드: 배지만 동기적으로 swap → 즉시 반영 (체감 0ms)
        // status 변경은 보고서 본문을 바꾸지 않으므로 풀 재로딩(patchMemberCard) 불필요.
        // patchMemberCard 를 호출하면 두 API RTT(2~3초) 만큼 배지 변경이 지연되는 문제 회피.
        if (isAdmin && _tOk) {
          if (_dashVisible()) {
            const card = document.getElementById(`srow_${data.member_name}`);
            const statusBox = card?.querySelector('.sr-status');
            if (statusBox) {
              if (data.status === 'needs_revision') {
                statusBox.innerHTML = '<span class="badge-new warning">보완 요청</span>';
              } else if (data.status === 'submitted') {
                statusBox.innerHTML = '<span class="badge-new success">✓ 제출</span>';
              }
            }
            // 카운트는 변동 없음 — submitted ↔ needs_revision 모두 'report 존재' = done.
          } else {
            _dashDirty();   // 현황 탭 복귀 시 재조회
          }
        }
        // 사용자 화면 상태 배지 실시간 갱신 (팀+이름 매칭 — 동명이인 오배송 방지)
        if (!isAdmin && _tOk && typeof user !== 'undefined' && user && user.name === data.member_name) {
          if (typeof invalidateMyReport === 'function') invalidateMyReport();   // 상태 바뀜 → 내 보고 캐시 무효화
          if (typeof updateBanner === 'function') updateBanner();
          // 본문의 "관리자가 보완을 요청했습니다" 안내 배너는 renderWriteForm 안에서
          // ex.status === 'needs_revision' 조건으로 생성됨. updateBanner 는 사이드/헤더만
          // 갱신하므로 폼도 다시 렌더해야 새로고침 없이 배너가 즉시 표시됨.
          if (typeof renderWriteForm === 'function' && document.getElementById('reportForm')) {
            renderWriteForm();
          }
          if (data.status === 'needs_revision') {
            toast('⚠️ 관리자가 보완을 요청했습니다. 내용을 확인하고 수정해주세요.', 'warn');
          } else if (data.status === 'submitted') {
            toast('✅ 상태가 제출 완료로 변경되었습니다.', 'ok');
          }
        }
      } else if (data.type === 'REPORT_DELETED') {
        // 내 보고가 삭제된 경우 캐시 무효화 (다음 렌더 때 DB 기준 반영)
        if (_tOk && typeof user !== 'undefined' && user && user.name === data.member_name
            && typeof invalidateMyReport === 'function') invalidateMyReport();
        if (isAdmin && _tOk) {
          if (_dashVisible()) patchMemberCard(data.member_name, data.week_key);
          else _dashDirty();   // 현황 탭 복귀 시 재조회
          // 관리자 알림 배너 — summary_stale 플래그로 AI 재요약 버튼 인라인 표시
          showWsNoti(data.member_name, data.week_key, 'REPORT_DELETED', false, !!data.summary_stale);
        }
      } else if (data.type === 'FINAL_REPORT_REVIEWED') {
        // 그룹장 결재 통지 — 해당 유닛의 결재권자(유닛장) 화면에서만 처리
        if (data.team_slug === getTeamSlug() && typeof isApprover !== 'undefined' && isApprover) {
          if (data.status === 'approved') {
            toast(`✅ ${olj('division_head','이')} 최종 보고를 승인했습니다.` + (data.comment ? ` 💬 ${data.comment}` : ''), 'ok');
          } else {
            toast(`↩️ ${orgLabel('division_head')} 보완요청: ${data.comment || ''} — 최종 취합에서 수정 후 재보고해주세요.`, 'warn');
          }
          if (typeof _fmRefreshSubmitState === 'function') _fmRefreshSubmitState();
          if (typeof updateFmCta === 'function') updateFmCta();   // 배너/사이드 결재 칩 즉시 갱신
        }
      }
    } catch (e) {
      console.error('[WS] 데이터 파싱 오류:', e);
    }
  };
  
  socket.onclose = () => {
    if (_wsHbTimer) { clearInterval(_wsHbTimer); _wsHbTimer = null; }
    socket = null;
    if (_wsManualClose) return;   // 로그아웃 등 의도적 종료 — 재연결 안함
    // 지수 백오프: 1s → 2s → 4s … 최대 30s (+지터). 서버 재시작 시 동시 재접속 폭주 방지.
    const delay = Math.min(30000, 1000 * Math.pow(2, _wsRetry++)) + Math.floor(Math.random() * 500);
    console.warn(`[WS] 연결 끊김. ${Math.round(delay / 1000)}초 후 재시도...`);
    _wsReconnTimer = setTimeout(setupWebSocket, delay);
  };

  socket.onerror = (err) => {
    console.error('[WS] 에러:', err);
    try { if (socket) socket.close(); } catch (_) {}
  };
}

// 로그아웃 등 의도적 종료 — 소켓·heartbeat·재연결 예약까지 전부 정리
function teardownWebSocket() {
  _wsManualClose = true;
  _wsWasConnected = false;
  if (_wsHbTimer) { clearInterval(_wsHbTimer); _wsHbTimer = null; }
  if (_wsReconnTimer) { clearTimeout(_wsReconnTimer); _wsReconnTimer = null; }
  try { if (socket) socket.close(); } catch (_) {}
  socket = null;
}

// 재연결 성공 시 1회 — 끊긴 동안 온 상태 변화(보완요청·결재 등)를 현재 화면 기준으로 따라잡기.
// 폴링 아님: 소켓이 실제로 끊겼다 다시 붙은 순간에만 호출된다.
function _wsResyncScreens() {
  try {
    const pgUser = document.getElementById('pgUser');
    if (pgUser && pgUser.classList.contains('active') && typeof user !== 'undefined' && user && !isAdmin) {
      if (typeof invalidateMyReport === 'function') invalidateMyReport();
      if (typeof updateBanner === 'function') updateBanner();
      if (typeof renderWriteForm === 'function' && document.getElementById('reportForm')) renderWriteForm();
    }
    const pgAdmin = document.getElementById('pgAdmin');
    const dashTab = document.getElementById('tabDash');
    if (isAdmin && pgAdmin && pgAdmin.classList.contains('active')
        && dashTab && dashTab.style.display !== 'none') {
      if (typeof _dashRenderedWeek !== 'undefined') _dashRenderedWeek = null;   // 주차 가드 해제 후 강제 재로드
      if (typeof renderDash === 'function') renderDash();
    }
    if (typeof isApprover !== 'undefined' && isApprover && typeof _fmRefreshSubmitState === 'function') {
      _fmRefreshSubmitState();
    }
  } catch (e) { console.warn('[WS] 재동기화 실패:', e); }
}

// 탭 포그라운드 복귀/네트워크 복구 시 소켓 점검 — 죽어 있으면 즉시 재연결.
// 모바일 백그라운드·프록시 유휴 종료 시 onclose 가 안 오는 좀비 소켓 대응.
function _wsEnsureAlive() {
  if (_wsManualClose) return;
  const token = (typeof getAuthToken === 'function') ? getAuthToken() : (localStorage.getItem('wr_token') || '');
  if (!token) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    // OPEN 으로 보여도 좀비일 수 있음 → ping 1발 프로브 (죽었으면 곧 onclose 발화 → 백오프 재연결)
    try { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); } catch (_) {}
    return;
  }
  if (_wsReconnTimer) { clearTimeout(_wsReconnTimer); _wsReconnTimer = null; }
  _wsRetry = 0;
  setupWebSocket();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _wsEnsureAlive();
});
window.addEventListener('online', _wsEnsureAlive);
