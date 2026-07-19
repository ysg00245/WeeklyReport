function applyUserToUI() {
  const userBtn = document.getElementById('userBtn');
  if (!user) {
    userBtn.innerHTML = `<span class="ava">?</span><span class="uc-text"><span>로그인</span></span>`;
    userBtn.className = 'user-chip';
    return;
  }
  const avaBg = nameToAvatarBg(user.name);
  const initial = avaInitial(user.name);
  const meta = [user.position, user.project].filter(Boolean).join(' · ');

  // 헤더 user-chip: 아바타 + (이름 / 메타) 2줄 — 아바타 꾸미기 반영
  userBtn.className = 'user-chip';
  userBtn.innerHTML = `
    ${avaMarkup(user.name)}
    <span class="uc-text">
      <span>${esc(user.name)}</span>
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
    </span>
  `;

  // 드롭다운 헤더: 큰 아바타 + 이름 + 메타 — 아바타 꾸미기 반영
  const dropAva = document.getElementById('userDropAvatar');
  if (dropAva) {
    const cfg = avatarCfg(user.name);
    if (cfg && cfg.img) {
      dropAva.textContent = '';
      dropAva.style.backgroundImage = `url('${cfg.img}')`;
      dropAva.style.backgroundSize = 'cover';
      dropAva.style.backgroundPosition = 'center';
    } else {
      dropAva.textContent = (cfg && cfg.initial) || initial;
      dropAva.style.backgroundImage = 'none';
      dropAva.style.background = (cfg && cfg.color) || avaBg;
    }
    dropAva.style.boxShadow = (cfg && cfg.border) ? `0 0 0 2px ${cfg.border}` : '';
  }
  document.getElementById('userDropName').innerHTML = `
    <span>${esc(user.name)}</span>
    ${meta ? `<span class="ud-meta">${esc(meta)}</span>` : ''}
  `;
}

function updateHeaderSessions() {
  try {
    const userWrap = document.getElementById('userWrap');
    const adminBtn = document.getElementById('adminBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const brandSub = document.getElementById('brandSub');
    if (!userWrap) return;

    if (isSysAdmin || isAdmin) {
      // 관리자 모드: 유저칩/관리자 진입 숨김, 로그아웃 아이콘 = 관리자 종료
      userWrap.style.display = 'none';
      if (adminBtn) adminBtn.style.display = 'none';
      if (logoutBtn) { logoutBtn.style.display = ''; logoutBtn.title = '관리자 종료'; }
      if (brandSub) brandSub.textContent = isSysAdmin ? '시스템 관리자' : '관리자 콘솔';
    } else if (user) {
      // 일반 유저: 유저칩 + 로그아웃 노출, 관리자 진입 숨김
      userWrap.style.display = '';
      if (adminBtn) adminBtn.style.display = 'none';
      if (logoutBtn) { logoutBtn.style.display = ''; logoutBtn.title = '로그아웃'; }
      if (brandSub) brandSub.textContent = '주간보고';
      applyUserToUI();
    } else {
      // 비로그인: 유저칩 숨김, 관리자 진입 아이콘 노출, 로그아웃 숨김
      userWrap.style.display = 'none';
      if (adminBtn) adminBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (brandSub) brandSub.textContent = '주간보고';
    }
  } catch (e) {
    console.error('Session UI Update Error:', e);
  }
}

// ═══════════════════════════════════════
//  로그인
// ═══════════════════════════════════════

// 이름 → 일관된 그라데이션 컬러 (DB에 color 컬럼이 없으므로 해시 기반)
const _AVA_PALETTE = [
  'linear-gradient(135deg,#5680ff,#1a36a3)',  // brand
  'linear-gradient(135deg,#7d70ff,#1f43c8)',  // ai-1
  'linear-gradient(135deg,#33d6da,#1f6feb)',  // ai-3
  'linear-gradient(135deg,#16a26b,#0f1f5c)',  // success-deep
  'linear-gradient(135deg,#b86b00,#7a3d00)',  // amber-deep
  'linear-gradient(135deg,#a78bfa,#6a5cff)',  // violet
  'linear-gradient(135deg,#5680ff,#16a26b)',  // teal-blend
  'linear-gradient(135deg,#1f43c8,#0f1f5c)',  // navy
];
function nameToAvatarBg(name) {
  if (!name) return _AVA_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
  return _AVA_PALETTE[Math.abs(hash) % _AVA_PALETTE.length];
}
function avaInitial(name) {
  return (name || '?').charAt(0);
}

// 멤버 아바타 꾸미기 설정 파싱 ({img,color,initial,border} 또는 null)
function avatarCfg(name) {
  const m = (members || []).find(x => x.name === name);
  if (!m || !m.avatar_config) return null;
  try { return typeof m.avatar_config === 'string' ? JSON.parse(m.avatar_config) : m.avatar_config; }
  catch { return null; }
}
// 모양(둥근 사각형) 스타일 — cfg.shape==='rounded' 면 모서리 둥근 사각형, 아니면 기본(원형)
function _avaShapeStyle(cfg) {
  return (cfg && cfg.shape === 'rounded') ? 'border-radius:28%;' : '';
}
// 원 안 글자 — 1자는 그대로, 2자 이상은 2열 그리드(4자=2x2, 3자=2+1, 2자=1행2열) + 자동 축소
function avaInnerHTML(txt) {
  const t = txt || '';
  const cps = [...t];
  const n = cps.length;
  if (n <= 1) return esc(t);
  const scale = n === 2 ? 0.5 : 0.4;
  const cells = cps.map(c => `<span>${esc(c)}</span>`).join('');
  return `<span style="display:grid;grid-template-columns:repeat(2,1fr);gap:0;font-size:${scale}em;line-height:1.02;font-weight:700;text-align:center;place-items:center">${cells}</span>`;
}
// 애니메이션 효과 클래스 (cfg.effect: shine|pulse|glow|float)
function _avaFxClass(cfg) {
  const fx = cfg && cfg.effect;
  return (fx && ['shine','pulse','glow','float','shake','bounce','heartbeat','spin','rainbow'].includes(fx)) ? ` ava-fx-${fx}` : '';
}
// 공용 아바타 마크업 — 사진/배경(색·그라데이션)/이니셜/테두리(링)/모양/효과 반영.
// cls: 'lg'|'md'|'' (CSS 사이즈), extra: 추가 인라인 스타일(크기 직접 지정 등)
function avaMarkup(name, cls = '', extra = '') {
  const cfg = avatarCfg(name);
  const ring = (cfg && cfg.border) ? `box-shadow:0 0 0 2px ${cfg.border};` : '';
  const shape = _avaShapeStyle(cfg);
  const fx = _avaFxClass(cfg);
  if (cfg && cfg.img) {
    return `<div class="ava ${cls}${fx}" style="background-image:url('${cfg.img}');background-size:cover;background-position:center;${ring}${shape}${extra}"></div>`;
  }
  const bg = (cfg && cfg.color) ? cfg.color : nameToAvatarBg(name);
  const initial = (cfg && cfg.initial) ? cfg.initial : avaInitial(name);
  return `<div class="ava ${cls}${fx}" style="background:${bg};${ring}${shape}${extra}">${avaInnerHTML(initial)}</div>`;
}
// 기존 .ava 엘리먼트(스타일 직접 설정 방식)에 아바타 적용 — 사진/배경/이니셜/테두리/모양/효과
function applyAvatarEl(el, name) {
  if (!el) return;
  const cfg = avatarCfg(name);
  el.classList.remove('ava-fx-shine','ava-fx-pulse','ava-fx-glow','ava-fx-float','ava-fx-shake','ava-fx-bounce','ava-fx-heartbeat','ava-fx-spin','ava-fx-rainbow');
  const fx = cfg && cfg.effect;
  if (fx && ['shine','pulse','glow','float','shake','bounce','heartbeat','spin','rainbow'].includes(fx)) el.classList.add('ava-fx-' + fx);
  el.style.borderRadius = (cfg && cfg.shape === 'rounded') ? '28%' : '';
  if (cfg && cfg.img) {
    el.innerHTML = '';
    el.style.backgroundImage = `url('${cfg.img}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundImage = 'none';
    el.style.background = (cfg && cfg.color) || nameToAvatarBg(name);
    el.innerHTML = avaInnerHTML((cfg && cfg.initial) || avaInitial(name));
  }
  el.style.boxShadow = (cfg && cfg.border) ? `0 0 0 2px ${cfg.border}` : '';
}

// 직급 정렬 순위 (낮을수록 위) — 멀티팀에서 본부장~사원까지 확장
const _POSITION_RANK = {
  '본부장':0,'연구소장':0,'이사':1,'팀장':2,'부장':3,
  '차장':4,'과장':5,'대리':6,'주임':7,'사원':8,
};
function positionRank(pos) {
  return _POSITION_RANK[pos] ?? 99;
}

// 프로젝트 정렬 (기타/빈값은 맨 뒤) — main UX 패치 보존
function projectSortKey(proj) {
  if (!proj || proj === '기타') return '￿'; // 유니코드 최대값 → 항상 마지막
  return proj;
}

// 팀원 그리드 + (호환용) hidden <select> 동시 렌더
function populateLoginSel() {
  // 정렬은 서버에서 직급 순으로 일관 적용됨 — 그대로 사용 (로그인/관리자/시스템콘솔 일관)
  const sorted = [...(members || [])];

  // hidden select (doLogin/loadMembers 호환)
  const sel = document.getElementById('loginSel');
  if (sel) {
    while (sel.options.length > 1) sel.remove(1);
    sorted.forEach(m => {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = m.position ? `${m.name} ${m.position}` : m.name;
      sel.appendChild(o);
    });
  }

  // 멤버 카드 그리드
  const grid = document.getElementById('memberGrid');
  if (grid) {
    if (!sorted.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-ico">👥</div><div class="empty-txt">등록된 ${olj('member','이')} 없습니다. 관리자가 먼저 ${olj('member','을')} 추가해주세요.</div></div>`;
    } else {
      grid.innerHTML = sorted.map(m => {
        // 팀장만 카드 좌상단 코너 뱃지 (absolute → 카드 높이 불변, 통일성 유지). 담당자는 뱃지 없음.
        // 화려함 4/10 — 은은한 brand 틴트 + 얇은 테두리, 그라데이션/그림자 없음. 글씨 가운데(inline-flex).
        // 그룹장(상위조직장) 우선 — 그룹 소속 구성원은 '유닛장'이 아니라 '그룹장'
        const badgeLabel = m.is_division_head ? orgLabel('division_head') : (m.is_leader ? orgLabel('leader') : '');
        const leaderBadge = badgeLabel
          ? '<span style="position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;color:var(--brand-700);background:color-mix(in oklab, var(--brand-500) 12%, transparent);border:1px solid color-mix(in oklab, var(--brand-500) 22%, transparent);padding:2px 8px;border-radius:7px;line-height:1.3">' + badgeLabel + '</span>'
          : '';
        return `
        <button type="button" class="member-card" data-name="${esc(m.name)}" style="position:relative">
          ${leaderBadge}
          ${avaMarkup(m.name, 'lg')}
          <div class="mc-name">${esc(m.name)}</div>
          <div class="mc-meta">${esc(m.position || '')}${m.position && m.project ? ' · ' : ''}${esc(m.project || '')}</div>
        </button>`;
      }).join('');
      grid.querySelectorAll('.member-card').forEach(btn => {
        btn.addEventListener('click', () => selectLoginMember(btn.dataset.name));
      });
    }

    // 주간보고 문의 담당자 안내 — 주보관리자(정·부) 우선, 없으면 팀장
    _renderReportContactNote(grid, sorted);
  }
}

// 로그인 화면 하단에 "주간보고 문의는 담당자에게" 안내 (담당자 = 팀장·주보관리자, 정/부 구분 없이 이름만)
function _renderReportContactNote(grid, mems) {
  const host = grid.parentElement;
  if (!host) return;
  let note = host.querySelector('#reportContactNote');
  // 이름은 평소 노출 안 함 — '주간보고 담당자'로만 안내. 담당자 지정 시 hover(데스크탑)/클릭(모바일)으로 이름 툴팁.
  const contacts = mems
    .filter(m => m.is_report_admin_primary || m.is_report_admin_secondary)
    .map(m => m.name);
  if (!note) {
    note = document.createElement('div');
    note.id = 'reportContactNote';
    note.style.cssText = 'margin-top:14px;font-size:12px;color:var(--text3);text-align:center;line-height:1.5';
    grid.insertAdjacentElement('afterend', note);
  }
  if (contacts.length) {
    const names = contacts.join(', ');
    note.innerHTML = `📩 주간보고 관련 문의는 <span title="담당자: ${esc(names)}" onclick="toast('주간보고 담당자: ${esc(names)}','info')" style="color:var(--text2);font-weight:600;border-bottom:1px dotted var(--text3);cursor:help">주간보고 담당자</span>에게 해주세요.`;
  } else {
    note.innerHTML = `📩 주간보고 관련 문의는 <b style="color:var(--text2)">주간보고 담당자</b>에게 해주세요.`;
  }
}

// 팀원 카드 클릭 → PIN 단계
function selectLoginMember(name) {
  const sel = document.getElementById('loginSel');
  if (sel) sel.value = name;

  const stepSelect = document.getElementById('loginStepSelect');
  const stepPin = document.getElementById('loginStepPin');
  if (stepSelect) stepSelect.style.display = 'none';
  if (stepPin) stepPin.style.display = '';

  // 선택된 팀원 정보
  const selName = document.getElementById('loginSelName');
  const selAva = document.getElementById('loginSelAvatar');
  if (selName) selName.textContent = name + '님';
  applyAvatarEl(selAva, name);

  // 에러/PIN 초기화
  clearPinInput();
  const err = document.getElementById('pinError');
  if (err) err.textContent = '';
  setTimeout(() => document.getElementById('p0')?.focus(), 80);
}

// 뒤로 가기 → 멤버 선택 단계
// PIN 단계의 '‹ 뒤로' 버튼 전용 — 그룹장 컨테이너(divhq-*)에서는 1인짜리 구성원 선택 화면 대신
// 팀 선택(picker)으로 나간다. (showPage 내부의 loginGoBack 호출과 분리 — 리다이렉트 루프 방지)
function loginBackFromPin() {
  const slug = (typeof getTeamSlug === 'function') ? getTeamSlug() : '';
  if (slug.startsWith('divhq-')) { location.href = '/'; return; }
  loginGoBack();
}

function loginGoBack() {
  const stepSelect = document.getElementById('loginStepSelect');
  const stepPin = document.getElementById('loginStepPin');
  if (stepSelect) stepSelect.style.display = '';
  if (stepPin) stepPin.style.display = 'none';

  const sel = document.getElementById('loginSel');
  if (sel) sel.value = '';
  clearPinInput();
  const err = document.getElementById('pinError');
  if (err) err.textContent = '';
}

function pinMove(idx) {
  const el = document.getElementById(`p${idx}`);
  el.value = el.value.replace(/\D/g, '');  // 숫자만 허용 (type=text 대응)
  let v = el.value;

  // 모바일에서 한 번에 여러 글자가 들어오는 경우(자동완성, 예측입력) 분배
  if (v.length > 1) {
    const chars = v.replace(/\D/g, '').split('');
    el.value = chars[0] || '';
    for (let i = 1; i < chars.length && idx + i <= 3; i++) {
      document.getElementById(`p${idx + i}`).value = chars[i];
    }
    v = el.value;
    const lastFilled = Math.min(idx + chars.length - 1, 3);
    if (lastFilled < 3) document.getElementById(`p${lastFilled + 1}`).focus();
  } else {
    if (v.length === 1 && idx < 3) document.getElementById(`p${idx+1}`).focus();
    if (v.length === 0 && idx > 0) document.getElementById(`p${idx-1}`).focus();
  }

  // .filled 시각 상태 갱신
  [0,1,2,3].forEach(i => {
    const cell = document.getElementById(`p${i}`);
    if (!cell) return;
    cell.classList.toggle('filled', cell.value.length === 1);
    cell.classList.remove('err');
  });
  const errBox = document.getElementById('pinError');
  if (errBox) errBox.textContent = '';

  // 4칸 모두 채워졌으면 자동 로그인
  const allFilled = [0,1,2,3].every(i => document.getElementById(`p${i}`).value.length === 1);
  if (allFilled) {
    setTimeout(doLogin, 60);
  }
}

function getPin() {
  return [0,1,2,3].map(i => document.getElementById(`p${i}`).value).join('');
}
function clearPinInput() {
  [0,1,2,3].forEach(i => {
    const el = document.getElementById(`p${i}`);
    if (el) { el.value = ''; el.classList.remove('filled','err'); }
  });
  document.getElementById('p0')?.focus();
}
function flashPinError(msg) {
  [0,1,2,3].forEach(i => document.getElementById(`p${i}`)?.classList.add('err'));
  const err = document.getElementById('pinError');
  if (err) err.textContent = msg || 'PIN을 다시 입력해주세요';
  setTimeout(() => {
    [0,1,2,3].forEach(i => document.getElementById(`p${i}`)?.classList.remove('err'));
  }, 400);
}

async function doLogin() {
  const name = document.getElementById('loginSel').value;
  const pin = getPin();
  if (!name) { toast(`${olj('member','을')} 선택해주세요`, 'err'); loginGoBack(); return; }
  if (pin.length !== 4) { flashPinError('PIN 4자리를 입력해주세요'); return; }

  showActionLoader('사용자 인증 중...');

  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name, pin }),
    });

    // 보안: 서버가 검증한 정식 이름만 신뢰 (입력 name은 fallback)
    const verifiedName = res.name || name;
    if (res.is_new) toast(`${verifiedName}님 PIN이 등록되었습니다`, 'ok');

    showActionLoader('데이터 동기화 중...');

    // 관리자 세션이 있다면 로그아웃
    isAdmin = false;
    localStorage.removeItem('wr_is_admin');
    document.getElementById('adminBtn').className = 'hdr-btn';

    const member = members.find(m => m.name === verifiedName);
    user = {
      name: verifiedName,
      role: member?.role || 'etc',
      position: member?.position || '',
      project: member?.project || '',
      sub_role: member?.sub_role || ''
    };
    localStorage.setItem('wr_user', JSON.stringify(user));
    if (res.token) localStorage.setItem('wr_token', res.token);   // 서버 세션 토큰 저장
    // 실시간 알림(보완요청 등) 즉시 수신 — 부팅 시점엔 토큰이 없어 WS 연결이 생략되므로
    // 로그인 성공 직후 여기서 연결해야 새로고침 없이도 소켓이 열린다.
    if (typeof setupWebSocket === 'function') setupWebSocket();
    localStorage.setItem('wr_user_ts', String(Date.now()));        // 세션 만료 검사용 타임스탬프
    if (typeof APP_VER !== 'undefined') localStorage.setItem('wr_app_ver', APP_VER);
    updateHeaderSessions();
    document.body.classList.add('logged-in');

    // 그룹장(상위조직장) → 그룹 보고 현황 콘솔 (유닛장 겸직 시에도 그룹 콘솔 우선, 탭으로 이동 가능)
    if (typeof memberIsDivisionHead === 'function' && memberIsDivisionHead(verifiedName) && typeof gotoDivisionHead === 'function') {
      await gotoDivisionHead();
      Promise.all([fetchUserPermissions(), renderWriteForm(), updateBanner()]).catch(() => {});
    } else
    // 결재권자(팀장/주간보고 담당자)면 결재권자 콘솔로, 아니면 일반 작성 화면으로
    if (typeof memberIsApprover === 'function' && memberIsApprover(verifiedName) && typeof gotoApprover === 'function') {
      await gotoApprover();
      // 본인 작성폼·권한·배너는 '내 보고 작성' 진입 대비 백그라운드 로드
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
      await showHrEvalNoticeIfNeeded();
    }

    // 주간보고 관리자 1회용 안내 (정/부) — 비밀번호 알림 팝업
    if (res.admin_pw_announcement && res.admin_pw_announcement.password) {
      showReportAdminAnnouncement(res.admin_pw_announcement);
    }

    // PWA 첫 로그인 — 알림 권한 자동 요청 (standalone 모드일 때만 1회)
    if (typeof autoPromptNotificationIfNeeded === 'function') {
      autoPromptNotificationIfNeeded();
    }
  } catch (e) {
    flashPinError(e.message);
    clearPinInput();
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  주간보고 관리자 1회용 안내 팝업
// ═══════════════════════════════════════
function showReportAdminAnnouncement(info) {
  // info = { role: '정' | '부', password: '...' }
  const role = info.role || '';
  const pw   = info.password || '';
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:16px;padding:28px 26px 22px;max-width:420px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.35);border:1px solid var(--border,#e5e7eb)">
      <div style="text-align:center;font-size:38px;line-height:1;margin-bottom:10px">🎉</div>
      <div style="text-align:center;font-size:18px;font-weight:700;color:var(--text,#0f172a);margin-bottom:6px">주간보고 관리자로 등록되었습니다</div>
      <div style="text-align:center;font-size:13px;color:var(--text-mute,#64748b);margin-bottom:18px">
        ${esc(user?.name || '')}님은 본 ${orgLabel('team')}의 <b>주간보고 관리자(${esc(role)})</b>로 지정되었습니다.<br>
        관리자 모드 진입 시 아래 비밀번호를 사용해주세요.
      </div>
      <div style="background:var(--surface-2,#f1f5f9);border:1px dashed var(--border,#cbd5e1);border-radius:10px;padding:14px 12px;margin-bottom:18px;text-align:center">
        <div style="font-size:11px;color:var(--text-mute,#64748b);letter-spacing:.5px;margin-bottom:6px">관리자 비밀번호</div>
        <div id="raAnnouncePw" style="font-family:'JetBrains Mono',Consolas,monospace;font-size:20px;font-weight:700;color:var(--accent,#1f43c8);letter-spacing:2px;word-break:break-all">${esc(pw)}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" id="raAnnounceCopy" class="btn" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border,#cbd5e1);background:var(--surface,#fff);color:var(--text,#0f172a);font-weight:600;cursor:pointer">📋 비밀번호 복사</button>
        <button type="button" id="raAnnounceOk" class="btn btn-primary" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--accent,#1f43c8);color:#fff;font-weight:600;cursor:pointer">확인</button>
      </div>
      <div style="margin-top:14px;font-size:11px;color:var(--text-mute,#94a3b8);text-align:center;line-height:1.5">
        ⚠️ 이 안내는 한 번만 표시됩니다. 비밀번호를 기억하거나 안전한 곳에 보관해주세요.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { try { document.body.removeChild(overlay); } catch (_) {} };
  overlay.querySelector('#raAnnounceOk')?.addEventListener('click', close);
  overlay.querySelector('#raAnnounceCopy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pw);
      toast('비밀번호가 복사되었습니다', 'ok');
    } catch (_) {
      toast('복사 실패 — 직접 메모해주세요', 'err');
    }
  });
}

// ═══════════════════════════════════════
//  팀원 로그인 공지 팝업
// ═══════════════════════════════════════
async function showHrEvalNoticeIfNeeded() {
  if (!user || isAdmin || isSysAdmin || isApprover) return;

  const week = (typeof currentWriteWeek !== 'undefined' && currentWriteWeek) || (typeof CW !== 'undefined' ? CW : '');
  if (!week) return;

  let untilTs = 0;
  try {
    const info = (typeof _deadlineInfo !== 'undefined' && _deadlineInfo && _deadlineInfo.week_key === week)
      ? _deadlineInfo
      : await api(`/api/settings/deadline/info?week=${encodeURIComponent(week)}`);
    if (info && info.deadline_at) {
      untilTs = new Date(info.deadline_at.replace(' ', 'T') + '+09:00').getTime();
    }
  } catch (_) {
    untilTs = 0;
  }

  const now = Date.now();
  if (!untilTs || untilTs <= now) {
    const fallback = new Date();
    fallback.setHours(23, 59, 59, 999);
    untilTs = fallback.getTime();
  }

  const key = `wr_hr_eval_notice_${getTeamSlug()}_${user.name}_${week}`;
  const hiddenUntil = parseInt(localStorage.getItem(key) || '0', 10);
  if (hiddenUntil && hiddenUntil > now) return;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:16px;max-width:430px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.35);border:1px solid var(--border,#e5e7eb);overflow:hidden">
      <div style="padding:26px 26px 18px">
        <div style="font-size:13px;font-weight:800;color:var(--brand-600,#1f43c8);margin-bottom:8px">공지사항</div>
        <div style="font-size:19px;font-weight:800;color:var(--text,#0f172a);margin-bottom:12px">주간보고 제출 안내</div>
        <div style="font-size:14px;color:var(--text2,#475569);line-height:1.7">
          주간보고 기한 내 미제출 누적 시 인사고과에 반영됩니다.<br>
          기한 내 제출 바랍니다.
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 26px;border-top:1px solid var(--line,var(--border,#e5e7eb));background:var(--surface2,#f8fafc)">
        <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text2,#64748b);cursor:pointer;line-height:1.4">
          <input type="checkbox" id="hrNoticeHideWeek" style="margin:0">
          이번 주 이 창을 열지 않음
        </label>
        <button type="button" id="hrNoticeOk" class="btn-new primary" style="min-width:84px">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    const hideWeek = overlay.querySelector('#hrNoticeHideWeek')?.checked;
    if (hideWeek) localStorage.setItem(key, String(untilTs));
    try { document.body.removeChild(overlay); } catch (_) {}
  };
  overlay.querySelector('#hrNoticeOk')?.addEventListener('click', close);
}

function toggleUserDrop() {
  if (!user) { showPage('pgLogin'); return; }
  document.getElementById('userDrop').classList.toggle('open');
}
function closeUserDrop() {
  document.getElementById('userDrop').classList.remove('open');
}
function goUserPage() {
  closeUserDrop();
  showPage('pgUser');
  renderWriteForm();
  updateBanner();
  const tabs = document.querySelectorAll('#pgUser .tab-new');
  tabs.forEach(t => t.classList.remove('active'));
  if (tabs[0]) tabs[0].classList.add('active');
  document.getElementById('tabWrite').style.display = '';
  document.getElementById('tabHistory').style.display = 'none';
}
function goHistoryPage() {
  closeUserDrop();
  showPage('pgUser');
  const tabs = document.querySelectorAll('#pgUser .tab-new');
  tabs.forEach(t => t.classList.remove('active'));
  if (tabs[1]) tabs[1].classList.add('active');
  document.getElementById('tabWrite').style.display = 'none';
  document.getElementById('tabHistory').style.display = '';
  renderHistory();
}
function doLogout() {
  closeUserDrop();
  // 시스템 관리자 종료 — 멀티팀 ON 이면 picker(/) 로, OFF 이면 default 팀 로그인 화면
  if (isSysAdmin) {
    if (!confirm('시스템 관리자 모드를 종료하시겠습니까?')) return;
    const tok = getAuthToken();
    if (tok) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    isSysAdmin = false;
    localStorage.removeItem('wr_sysadmin_token');
    localStorage.removeItem('wr_token');
    // 멀티팀 상태에 따라 분기 — 시스템 관리자가 설정을 바꾼 직후에도 일관된 동작
    showActionLoader('로그아웃 중...');
    (async () => {
      try {
        // 캐시된 landing 우선 사용 (즉시) — 없을 때만 fetch
        const landing = (typeof _getLanding === 'function')
          ? await _getLanding()
          : await fetch('/api/settings/landing-config', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
        if (landing && landing.multi_team_enabled) {
          try { localStorage.removeItem('wr_last_team'); } catch (_) {}
          location.replace('/');               // picker 강제 표시
        } else {
          const ds = (landing && landing.default_team_slug) || 'default';
          localStorage.setItem('wr_last_team', ds);
          location.replace('?team=' + encodeURIComponent(ds));
        }
      } catch (_) {
        location.replace('/');
      }
    })();
    return;
  }
  // 팀 관리자 종료 — 팀 관리자는 특정 팀 컨텍스트가 있으므로, 멀티팀이어도 picker 가 아니라
  // '그 팀 로그인 화면'(?team=<마지막팀>)으로 복귀한다. (picker 는 팀 컨텍스트 없는 시스템 관리자 전용)
  if (isAdmin) {
    if (!confirm('관리자 모드를 종료하시겠습니까?')) return;
    const tok = getAuthToken();
    if (tok) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    isAdmin = false;
    localStorage.removeItem('wr_is_admin');
    localStorage.removeItem('wr_token');
    const ds = localStorage.getItem('wr_last_team') || 'default';
    location.replace('?team=' + encodeURIComponent(ds));
    return;
  }
  if (!confirm('로그아웃 하시겠습니까?')) return;
  // 서버 세션 무효화 (fire-and-forget)
  const tok = getAuthToken();
  if (tok) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // WS 정리 — 재연결 루프까지 멈춰야 무효 토큰으로 재접속 시도하는 좀비 루프가 안 생긴다
  if (typeof teardownWebSocket === 'function') teardownWebSocket();
  user = null;
  isApprover = false;
  isDivAdmin = false;
  document.body.classList.remove('approver-mode');
  localStorage.removeItem('wr_user');
  localStorage.removeItem('wr_token');
  document.body.classList.remove('logged-in');
  updateHeaderSessions();
  showPage('pgLogin');
  clearPinInput();
}
document.addEventListener('click', e => {
  const wrap = document.getElementById('userWrap');
  if (wrap && !wrap.contains(e.target)) closeUserDrop();
});
