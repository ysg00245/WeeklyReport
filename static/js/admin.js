// ═══════════════════════════════════════
//  관리자
// ═══════════════════════════════════════
function openAdminModal() {
  if (isAdmin) { gotoAdmin(); return; }
  const modal = document.getElementById('modalAdmin');
  const pwIn = document.getElementById('adminPwIn');
  modal.classList.add('show');
  pwIn.value = '';
  // 렌더링 두 프레임 대기 후 포커스 (모바일/일부 브라우저에서 display:flex 직후 focus 무시되는 이슈 방지)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    pwIn.focus();
    pwIn.click(); // 일부 모바일 브라우저에서 키보드 활성화 보조
  }));
}
function handleAdminBtn() {
  // 관리자 페이지에 있을 때 누르면 로그아웃, 그 외엔 관리자 페이지로 이동
  if (isAdmin) {
    const curP = localStorage.getItem('wr_cur_page');
    if (curP === 'pgAdmin') {
      if (!confirm('관리자 모드를 종료하시겠습니까?')) return;
      isAdmin = false;
      localStorage.removeItem('wr_is_admin');
      updateHeaderSessions();
      if (user) showPage('pgUser');
      else showPage('pgLogin');
    } else {
      gotoAdmin();
    }
    return;
  }
  openAdminModal();
}
async function checkAdmin() {
  const pw = document.getElementById('adminPwIn').value;
  if (!pw) { toast('비밀번호를 입력해주세요', 'err'); return; }

  // api 호출 전에 로더 표시 (네온DB 왕복 ~1초 동안 피드백)
  showActionLoader('관리자 로그인 중...');

  try {
    const res = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    });

    // ── 팀 선택 화면(picker)에서의 '팀 관리자' 로그인 차단 ──
    // picker 는 URL 에 ?team= 이 없어 X-Team-Slug 가 'default' 로 잡힌다.
    // 그 상태로 팀 관리자로 로그인하면 엉뚱한 default 팀(빈 팀) 콘솔이 떠 버린다.
    // → 팀 관리자는 팀을 먼저 선택(?team=slug)한 뒤 로그인하도록 막고 안내.
    //   (시스템 관리자는 팀 무관 인증이라 그대로 허용)
    const _noTeamCtx = !new URLSearchParams(location.search).get('team');
    if (_noTeamCtx && res && !res.is_system_admin) {
      // 방금 발급된 default-팀 토큰은 서버에서 정리 (미사용 세션 남기지 않음)
      if (res.token) {
        try { await api('/api/auth/logout', { method: 'POST', headers: { 'X-Auth-Token': res.token } }); } catch (_) {}
      }
      hideActionLoader();
      closeModal('modalAdmin');
      document.getElementById('adminPwIn').value = '';
      toast(`${olj('team','을')} 먼저 선택한 뒤 관리자 로그인 해주세요`, 'err');
      return;
    }

    // 관리자 세션 토큰 저장
    if (res && res.token) localStorage.setItem('wr_token', res.token);

    // 토큰 저장
    if (res && res.token) {
      if (res.is_system_admin) {
        localStorage.setItem('wr_sysadmin_token', res.token);
      } else {
        localStorage.setItem('wr_token', res.token);
      }
      // 로그인 직후 WS 연결 — 부팅 시점엔 토큰이 없어 생략됐으므로 여기서 열어야
      // 새로고침 없이 실시간 제출/보완 알림을 받는다.
      if (typeof setupWebSocket === 'function') setupWebSocket();
    }

    // 일반 직원 세션이 있다면 정리
    user = null;
    localStorage.removeItem('wr_user');
    document.body.classList.remove('logged-in');
    document.getElementById('loginSel').value = '';
    if (typeof clearPinInput === 'function') clearPinInput();
    closeModal('modalAdmin');

    // 시스템 관리자 vs 팀 관리자 분기
    if (res && res.is_system_admin) {
      isSysAdmin = true;
      updateHeaderSessions();
      await gotoSysAdmin();
    } else {
      isAdmin = true;
      localStorage.setItem('wr_is_admin', 'true');
      updateHeaderSessions();
      await gotoAdmin();
    }
  } catch (e) {
    hideActionLoader();
    toast(e.message, 'err');
    document.getElementById('adminPwIn').value = '';
  }
}

async function gotoAdmin() {
  _applyConsoleMode(false);   // 전체 관리자 모드 (운영 탭 노출)
  showPage('pgAdmin');
  showActionLoader('관리자 모드 전환 중...');

  try {
    // 현황 탭 데이터까지 로딩 완료 후 초기 로더 해제.
    // members 는 부트스트랩이 인증 상태로 이미 채웠으면 재사용 (비인증 로드였으면 PIN 정보가 없어 재조회)
    if (!Array.isArray(members) || !members.length || !_membersAuthed) await loadMembers();
    await renderDash();
    loadMetrics(); // 비동기 백그라운드 — 차트는 나중에 그려져도 OK

    // 팀원 관리·PIN 탭은 백그라운드 (현황 탭 진입 후 필요 시 렌더)
    renderRoleTable();
    renderPinTable();
  } finally {
    hideActionLoader();
  }
}

// ── 콘솔 UI 모드 토글 ─────────────────────────────────────
// approver=true → 결재권자 경량뷰: 팀원관리/양식설정 탭 + 보완요청/삭제/권한부여 숨김, '내 보고 작성' 노출.
// 같은 pgAdmin 을 admin_pw 관리자와 결재권자가 공유하므로, 진입 시마다 모드를 명시적으로 세팅한다.
function _applyConsoleMode(approver) {
  isApprover = !!approver;
  document.body.classList.toggle('approver-mode', !!approver);
  const mem  = document.getElementById('tabBtnMembers');
  const set  = document.getElementById('tabBtnSettings');
  const wbtn = document.getElementById('approverWriteBtn');
  const hbtn = document.getElementById('approverHistoryBtn');
  const title= document.getElementById('adminTitle');
  const sub  = document.getElementById('adminSubtitle');
  if (mem)  mem.style.display  = approver ? 'none' : '';
  if (set)  set.style.display  = approver ? 'none' : '';
  if (wbtn) wbtn.style.display = approver ? '' : 'none';
  if (hbtn) hbtn.style.display = approver ? '' : 'none';
  if (title) title.textContent = approver ? `${orgLabel('team')} 보고 현황` : '관리자 콘솔';
  if (sub)   sub.textContent   = approver ? `${orgLabel('team')} 주간보고 열람 · AI 요약 · 내 보고 작성` : `${orgLabel('team')} 주간보고 현황 · AI 요약 · 양식 관리`;

  // 보고받는 사람용 간소화: KPI 4카드 + 운영처리량 차트 숨기고 한 줄 요약으로 대체
  const statsEl   = document.querySelector('#pgAdmin .stats-new');
  const metricsEl = document.getElementById('metricsCard');
  const apvSum    = document.getElementById('apvDashSummary');
  if (statsEl)   statsEl.style.display   = approver ? 'none' : '';
  if (metricsEl) metricsEl.style.display = approver ? 'none' : '';
  if (apvSum)    apvSum.style.display    = approver ? 'flex' : 'none';
}

// 결재권자(팀장/주간보고 담당자)가 본인 PIN 으로 로그인 시 진입하는 경량 콘솔.
async function gotoApprover() {
  _applyConsoleMode(true);
  // 현황 탭만 활성화
  document.getElementById('tabDash').style.display     = '';
  document.getElementById('tabMembers').style.display  = 'none';
  document.getElementById('tabSettings').style.display = 'none';
  document.querySelectorAll('#pgAdmin .tab-new').forEach(t => t.classList.remove('active'));
  document.getElementById('tabBtnDash')?.classList.add('active');
  showPage('pgAdmin');
  showActionLoader(`${orgLabel('team')} 보고 현황 로딩 중...`);
  try {
    if (!Array.isArray(members) || !members.length || !_membersAuthed) await loadMembers();
    await renderDash();
    loadMetrics();
  } finally {
    hideActionLoader();
  }
}

// ── 결재권자 콘솔: 내 보고 작성 / 과거 이력 (pgUser 재사용, 결재권자 헤더로 감싸 페이지 전환감 제거) ──
function _exitApvUserHeader() {
  // 일반 팀원 모드 복귀 — 기본 헤더 노출, 결재권자 헤더 숨김
  const d = document.getElementById('userDefaultHead'); if (d) d.style.display = '';
  const h = document.getElementById('apvHeaderUser');   if (h) h.style.display = 'none';
}

function apvUserTab(tab) {
  showPage('pgUser');
  // 결재권자 헤더 노출(기본 헤더 숨김) + 탭 활성표시
  const d = document.getElementById('userDefaultHead'); if (d) d.style.display = 'none';
  const h = document.getElementById('apvHeaderUser');   if (h) h.style.display = '';
  document.querySelectorAll('#apvHeaderUser .tab-new').forEach(t => t.classList.remove('active'));
  document.getElementById(tab === 'history' ? 'apvUserHistTab' : 'apvUserWriteTab')?.classList.add('active');
  // 컨텐츠 토글 (uTab 과 동일 규칙)
  document.getElementById('tabWrite').style.display   = tab === 'write'   ? '' : 'none';
  document.getElementById('tabHistory').style.display = tab === 'history' ? '' : 'none';
  if (tab === 'write') renderWriteForm(); else renderHistory();
}

function goApproverWrite()   { apvUserTab('write'); }
function goApproverHistory() { apvUserTab('history'); }

// ── 카드 HTML 빌더 (renderDash + patchMemberCard 공용) ──
function buildACard(name, r, wk, canPermit) {
  const role = r ? r.role : getRole(name);
  const pos  = r ? (r.position || '') : getPosition(name);
  const proj = r ? (r.project  || '') : (members.find(x => x.name === name)?.project || '');
  const avaBg = nameToAvatarBg(name);
  const initial = avaInitial(name);
  // 세부역할 우선: 제출된 보고서의 sub_role(시점 보존) → members.sub_role → role 한국어
  const sub = (r?.sub_role) || subRoleLabel(name);
  const metaLine = [pos, sub].filter(Boolean).join(' · ');

  // 상태 배지
  let statusBadge;
  if (r) {
    statusBadge = r.status === 'needs_revision'
      ? `<span class="badge-new warning">보완 요청</span>`
      : `<span class="badge-new success">✓ 제출</span>`;
  } else {
    statusBadge = `<span class="badge-new">⏳ 미제출</span>${canPermit ? `<button class="miss-chip-new clickable" onclick="event.stopPropagation(); openPermModal('${name}','${wk}')">🔓 권한 부여</button>` : ''}`;
  }

  const hasContent = r && (r.done || r.plan || r.issue);
  const chev = r ? `<span class="sr-chev">▾</span>` : '';

  return `<div class="submit-row" id="srow_${esc(name)}">
    <div class="submit-row-head" onclick="togAcard(this,'${esc(name)}','${esc(wk)}')">
      ${avaMarkup(name, '', 'width:36px;height:36px;font-size:13px')}
      <div class="sr-info">
        <div class="sr-name">${esc(name)}<span class="faint">${esc(metaLine)}</span></div>
        <div class="sr-proj">${esc(proj || '-')}</div>
      </div>
      <div class="sr-status">${statusBadge}</div>
      ${chev}
    </div>
    <div class="submit-row-body" id="ac_${esc(name)}" style="display:none">
      ${r ? `
        <div class="sr-meta">
          <span>📅</span> 작성일시: <strong>${esc(r.submitted_at || '-')}</strong>
        </div>
        ${rfFields(r)}
        ${isApprover ? '' : `<div class="row-flex" style="margin-top:12px;gap:6px;justify-content:flex-end">
          <button class="btn-new ghost sm" onclick="markNeedsRevision('${esc(name)}', '${esc(wk)}')">⚠️ 보완 요청</button>
          <button class="btn-new ghost sm" style="color:var(--danger)" onclick="deleteReport('${esc(name)}', '${esc(wk)}')">🗑️ 삭제</button>
        </div>`}
      ` : '<div style="color:var(--text2);font-size:12px">미제출 보고서</div>'}
    </div>
  </div>`;
}

// ── WebSocket 수신 시 해당 팀원 카드만 부분 갱신 (제출/삭제 공용) ──
async function patchMemberCard(memberName, weekKey) {
  const wk = document.getElementById('adminWeekSel')?.value;
  if (!wk || wk !== weekKey) return;

  // 두 API 를 병렬 호출 — 순차 호출 시 RTT 합산되어 체감 2~3초 지연 발생
  const [reportRes, dlRes] = await Promise.allSettled([
    api(`/api/reports/${encodeURIComponent(memberName)}?week=${weekKey}`),
    api(`/api/settings/deadline/info?week=${wk}`),
  ]);
  let report = null;
  if (reportRes.status === 'fulfilled' && reportRes.value?.member_name) {
    report = reportRes.value;
  }
  const isPassed = (dlRes.status === 'fulfilled') ? !!dlRes.value?.is_passed : false;
  const canPermit = !isApprover && ((wk !== CW) || isPassed);   // 결재권자는 권한 부여 불가

  // 해당 카드 DOM 교체 (제출 여부와 무관하게 항상 교체)
  // 펼침 상태(.open) 였다면 새 카드에도 적용 — 사용자 인터랙션 보존
  const existingCard = document.getElementById(`ac_${memberName}`)?.closest('.submit-row');
  const wasOpen = !!existingCard?.classList.contains('open');
  if (existingCard) {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildACard(memberName, report, wk, canPermit);
    existingCard.replaceWith(tmp.firstChild);
    if (wasOpen) {
      const newCard = document.getElementById(`srow_${memberName}`);
      if (newCard) {
        newCard.classList.add('open');
        const body = newCard.querySelector('.submit-row-body');
        if (body) body.style.display = '';
      }
    }
  }

  // ── 카운트·라벨 재집계 (DOM 기반, 상태 전이 무관 정합) ──
  // ±1 산수 대신 현재 렌더된 .submit-row 들의 배지 클래스로 재카운트.
  // 미제출↔제출↔보완요청↔삭제 어떤 전이든 항상 정확.
  const rows = document.querySelectorAll('#reportList .submit-row');
  const missNames = [];
  let done = 0;
  rows.forEach(row => {
    const badge = row.querySelector('.sr-status .badge-new');
    const hasReport = badge && (badge.classList.contains('success') || badge.classList.contains('warning'));
    if (hasReport) {
      done++;
    } else {
      // row id = "srow_${name}" → 접두어 제거해 이름 복원
      const nm = row.id.startsWith('srow_') ? row.id.slice(5) : '';
      if (nm) missNames.push(nm);
    }
  });
  const total = rows.length;
  const miss  = missNames.length;
  const rate  = total ? Math.round(done / total * 100) : 0;

  document.getElementById('stDone').textContent = done;
  document.getElementById('stMiss').textContent = miss;
  document.getElementById('stRate').textContent = rate + '%';
  const stDoneTotal = document.getElementById('stDoneTotal');
  if (stDoneTotal) stDoneTotal.textContent = ` / ${total}`;
  const stRateBar = document.getElementById('stRateBar');
  if (stRateBar) stRateBar.style.width = rate + '%';
  const stMissNote = document.getElementById('stMissNote');
  if (stMissNote) stMissNote.textContent = miss === 0 ? '🎉 전원 제출' : `${miss}명 미제출`;

  // 미제출자 칩 영역도 renderDash 와 동일 규칙으로 통째 재구성 → 항상 정합
  const missArea = document.getElementById('missArea');
  if (missArea) {
    if (total === 0) {
      missArea.innerHTML = `<div style="color:var(--text3);font-size:13px;margin-bottom:14px">${orgLabel('member')} 등록이 필요합니다. ${orgLabel('member')} 관리에서 추가해주세요.</div>`;
    } else if (miss === 0) {
      missArea.innerHTML = `<div style="color:var(--success);font-size:13px;margin-bottom:14px">🎉 전원 제출 완료!</div>`;
    } else {
      missArea.innerHTML = `<div class="sec-title">미제출자${canPermit ? ' <span style="font-size:11px;font-weight:400;color:var(--text3)">(이름 클릭 시 수정권한 부여)</span>' : ''}</div><div class="miss-row">${missNames.map(m =>
        `<span class="miss-chip${canPermit?' clickable':''}" style="margin-right:4px"${canPermit?` onclick="openPermModal('${m}','${wk}')"`:''}>${m}</span>`
      ).join('')}</div>`;
    }
  }
}

function aTab(tab, el) {
  document.querySelectorAll('#pgAdmin .tab-new, #pgAdmin .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('tabDash').style.display    = tab === 'dash'    ? '' : 'none';
  document.getElementById('tabMembers').style.display = tab === 'members' ? '' : 'none';
  document.getElementById('tabSettings').style.display= tab === 'settings'? '' : 'none';
  // 현황 탭 복귀: 이미 렌더된 주차면 재동기화 생략 (WebSocket 이 카드를 실시간 갱신하므로 최신 상태 유지)
  if (tab === 'dash') {
    const wk = document.getElementById('adminWeekSel')?.value;
    if (_dashRenderedWeek !== wk) renderDash();
  }
  if (tab === 'members') loadPermissions();
  if (tab === 'settings') { loadSettingsToEditor(); loadAiPrompts(); loadDeadlineSettings(); }
}

function populateAdminWeekSel() {
  const sel = document.getElementById('adminWeekSel');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = ''; // 기존 옵션 초기화
  for (let i = 0; i < 10; i++) {
    const d = new Date(); d.setDate(d.getDate() - i * 7);
    const k = getWeekKey(d);
    const o = document.createElement('option');
    o.value = k;
    o.textContent = getWeekLabel(k) + ' (' + weekRange(k) + ')';
    if (k === (currentVal || CW)) o.selected = true;
    sel.appendChild(o);
  }
}

let _dashRenderedWeek = null;   // 마지막으로 렌더한 현황 주차 — 탭 복귀 시 불필요한 재동기화 방지
async function renderDash() {
  const wk = document.getElementById('adminWeekSel').value;
  if (!wk) return;
  _dashRenderedWeek = wk;
  if (typeof updateFmCta === 'function') updateFmCta();   // 최종 취합 CTA (결재권자 전용, 주차 연동)

  const listEl = document.getElementById('reportList');
  const isInitial = !listEl.innerHTML;
  
  if (!isInitial) {
    showActionLoader('데이터 동기화 중...');
  } else {
    listEl.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text3); font-size:13px">📊 현황 데이터를 불러오는 중입니다...</div>';
  }

  // 집계 대상만: 팀별 관리자가 '집계대상' 해제한 멤버(is_report_target=false)는 제외 (명단엔 보이되 미제출/제출률에선 빠짐)
  const allNames = members.filter(m => m.is_report_target !== false).map(m => m.name);
  let reports = [];
  let isPassed = false;
  try {
    reports = await api(`/api/reports?week=${wk}`);
    try {
      const dlInfo = await api(`/api/settings/deadline/info?week=${wk}`);
      isPassed = dlInfo.is_passed;
    } catch(e) {}
  } catch (e) {
    console.error('현황 데이터 로드 실패', e);
  } finally {
    if (!isInitial) hideActionLoader();
  }
  const canPermit = !isApprover && ((wk !== CW) || isPassed);   // 결재권자는 권한 부여 불가 (운영 기능)
  const reportMap = {};
  reports.forEach(r => { reportMap[r.member_name] = r; });

  const done = allNames.filter(m => reportMap[m]);
  const miss = allNames.filter(m => !reportMap[m]);

  const rate = allNames.length ? Math.round(done.length / allNames.length * 100) : 0;
  document.getElementById('stTotal').textContent = allNames.length;
  document.getElementById('stDone').textContent = done.length;
  const totalEl = document.getElementById('stDoneTotal');
  if (totalEl) totalEl.textContent = ` / ${allNames.length}`;
  document.getElementById('stMiss').textContent = miss.length;
  document.getElementById('stRate').textContent = rate + '%';
  const barEl = document.getElementById('stRateBar');
  if (barEl) barEl.style.width = rate + '%';
  const missNote = document.getElementById('stMissNote');
  if (missNote) missNote.textContent = miss.length === 0 ? '🎉 전원 제출' : `${miss.length}명 미제출`;

  // 보고받는 사람용 간소 요약 카드 — 미제출은 hover(데스크탑)/클릭(모바일) 시 명단 툴팁
  const apvText = document.getElementById('apvSummaryText');
  if (apvText) {
    if (miss.length === 0) {
      apvText.innerHTML = `🎉 이번 주 전원 제출 <span style="color:var(--text3);font-weight:500">(${done.length}/${allNames.length})</span>`;
    } else {
      const missStr = miss.join(', ');
      apvText.innerHTML = `📊 이번 주 제출 <b>${done.length}</b><span style="color:var(--text3)"> / ${allNames.length}명</span> · ` +
        `<span title="미제출: ${esc(missStr)}" onclick="toast('미제출: ${esc(missStr)}','info')" style="color:var(--warning);font-weight:700;border-bottom:1px dotted var(--warning);cursor:help">미제출 ${miss.length}명</span>`;
    }
  }

  document.getElementById('missArea').innerHTML = allNames.length === 0
    ? `<div style="color:var(--text3);font-size:13px;margin-bottom:14px">${orgLabel('member')} 등록이 필요합니다. ${orgLabel('member')} 관리에서 추가해주세요.</div>`
    : miss.length > 0
      ? `<div class="sec-title">미제출자${canPermit ? ' <span style="font-size:11px;font-weight:400;color:var(--text3)">(이름 클릭 시 수정권한 부여)</span>' : ''}</div><div class="miss-row">${miss.map(m=>{
          return `<span class="miss-chip${canPermit?' clickable':''}" style="margin-right:4px"${canPermit?` onclick="openPermModal('${m}','${wk}')"`:''}>${m}</span>`;
        }).join('')}</div>`
      : `<div style="color:var(--success);font-size:13px;margin-bottom:14px">🎉 전원 제출 완료!</div>`;

  document.getElementById('reportList').innerHTML = allNames.map(name => {
    const r = reportMap[name];
    return buildACard(name, r, wk, canPermit);
  }).join('');
  loadSavedSummary(wk);
}

async function markNeedsRevision(name, wk) {
  if (!confirm(`${name}님의 보고서에 대해 보완을 요청하시겠습니까?\n(삭제되지 않으며 상태만 보완요청으로 변경됩니다)`)) return;
  showActionLoader('보완요청 처리 중...');
  try {
    await api(`/api/reports/${encodeURIComponent(name)}/status?week=${wk}&status=needs_revision`, { method: 'PUT' });
    toast('보완요청 상태로 변경되었습니다.', 'ok');
    // 풀 리렌더(renderDash) 대신 본인 카드 배지만 swap — REPORT_STATUS_CHANGED WS 가
    // 곧 도착하여 같은 swap 을 idempotent 하게 수행하므로 중복 작업 아님.
    const statusBox = document.getElementById(`srow_${name}`)?.querySelector('.sr-status');
    if (statusBox) statusBox.innerHTML = '<span class="badge-new warning">보완 요청</span>';
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function deleteReport(name, wk) {
  if (!confirm(`${name}님의 보고서를 정말로 '삭제'하시겠습니까?\n(데이터가 완전히 삭제되어 복구할 수 없습니다)`)) return;
  showActionLoader('보고서 삭제 중...');
  try {
    await api(`/api/reports/${encodeURIComponent(name)}?week=${wk}`, { method: 'DELETE' });
    toast('보고서가 삭제되었습니다.', 'ok');
    // 풀 리렌더 대신 해당 카드만 patch — REPORT_DELETED WS 가 곧 같은 패치를
    // idempotent 하게 호출. 우선 즉각 반영을 위해 본인도 호출.
    patchMemberCard(name, wk);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function rfFields(r) {
  let html = '';
  const schema = (globalSettings.roles_schema && globalSettings.roles_schema[r.role]) ? globalSettings.roles_schema[r.role] : null;

  if (schema) {
    let countersHtml = '';
    let textareasHtml = '';
    
    schema.forEach(f => {
      const val = r.custom_data && r.custom_data[f.id] !== undefined ? r.custom_data[f.id] : (r[f.id] || '');
      if (f.type === 'counter' && val) {
        countersHtml += `<span style="background:${f.color}26;color:${f.color};border:1px solid ${f.color}4D;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700">${f.label} <b>${val}</b></span>`;
      } else if (f.type === 'textarea' && val) {
        textareasHtml += `<div class="rf-sec"><div class="rf-lbl">${f.label}</div><div class="rf-val">${esc(val)}</div></div>`;
      }
    });

    if (countersHtml) {
      html += `<div class="rf-sec"><div class="rf-lbl">📋 수치 항목</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">${countersHtml}</div></div>`;
    }
    html += textareasHtml;
  } else {
    // 레거시 렌더링
    const hasCnt = r.sor_cnt || r.sop_cnt || r.chg_cnt;
    if (hasCnt) {
      html += `<div class="rf-sec"><div class="rf-lbl">📋 운영 처리 현황</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        ${r.sor_cnt ? `<span style="background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700">SOR <b>${r.sor_cnt}</b>건</span>` : ''}
        ${r.sop_cnt ? `<span style="background:rgba(244,114,182,.15);color:#f472b6;border:1px solid rgba(244,114,182,.3);padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700">SOP <b>${r.sop_cnt}</b>건</span>` : ''}
        ${r.chg_cnt ? `<span style="background:rgba(45,212,191,.15);color:#2dd4bf;border:1px solid rgba(45,212,191,.3);padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700">변경 <b>${r.chg_cnt}</b>건</span>` : ''}
      </div></div>`;
    }
    html += [
      ['✅ 완료 업무', r.done],['📌 다음 주 계획', r.plan],
      ['⚠️ 이슈/요청', r.issue],['🔔 특이사항', r.note]
    ].filter(([,v])=>v).map(([t,v])=>`
      <div class="rf-sec"><div class="rf-lbl">${t}</div><div class="rf-val">${esc(v)}</div></div>
    `).join('');
  }
  
  return html;
}

function togAcard(hdr, name, wk) {
  const row = hdr.closest('.submit-row');
  const body = hdr.nextElementSibling;
  if (!body) return;
  const isOpen = body.style.display === '' || body.style.display === 'block';
  if (isOpen) {
    body.style.display = 'none';
    row?.classList.remove('open');
  } else {
    body.style.display = '';
    row?.classList.add('open');
  }
}

async function copyAll() {
  const wk = document.getElementById('adminWeekSel').value;
  let reports = [];
  try { reports = await api(`/api/reports?week=${wk}`); } catch {}
  const reportMap = {};
  reports.forEach(r => { reportMap[r.member_name] = r; });

  let txt = `[${getWeekLabel(wk)} ${weekRange(wk)} 주간보고]\n${'='.repeat(50)}\n\n`;
  members.filter(m => m.is_report_target !== false).forEach(m => {
    const r = reportMap[m.name];
    txt += `▶ ${m.name} [${m.role==='dev'?'개발':m.role==='ops'?'운영':'기타'}]\n`;
    if (r) {
      if(r.done) txt += `[완료]\n${r.done}\n\n`;
      if(r.plan) txt += `[계획]\n${r.plan}\n\n`;
      if(r.issue) txt += `[이슈]\n${r.issue}\n\n`;
      if(r.note) txt += `[특이사항]\n${r.note}\n\n`;
      if(r.sor_cnt) txt += `[SOR] ${r.sor_cnt}건\n`;
      if(r.sop_cnt) txt += `[SOP] ${r.sop_cnt}건\n`;
      if(r.chg_cnt) txt += `[변경계획서] ${r.chg_cnt}건\n`;
    } else { txt += '(미제출)\n\n'; }
    txt += '-'.repeat(40) + '\n\n';
  });
  navigator.clipboard.writeText(txt).then(() => toast('📋 클립보드에 복사됐습니다', 'ok'));
}

async function exportTxt() {
  const wk = document.getElementById('adminWeekSel').value;
  let reports = [];
  try { reports = await api(`/api/reports?week=${wk}`); } catch {}
  const reportMap = {};
  reports.forEach(r => { reportMap[r.member_name] = r; });

  let txt = `${getWeekLabel(wk)} 주간보고\n\n`;
  members.filter(m => m.is_report_target !== false).forEach(m => {
    const r = reportMap[m.name];
    txt += `=== ${m.name} ===\n`;
    if (r) { txt += `완료: ${r.done}\n계획: ${r.plan}\n이슈: ${r.issue||'-'}\n특이: ${r.note||'-'}\n`; }
    else { txt += '미제출\n'; }
    txt += '\n';
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], {type:'text/plain;charset=utf-8'}));
  a.download = `주간보고_${wk}.txt`;
  a.click();
}

let permTargetName = '';
let permTargetWeek = '';

function openPermModal(name, wk) {
  permTargetName = name;
  permTargetWeek = wk;
  document.getElementById('permModalName').textContent = name;
  document.getElementById('permModalWeek').textContent = getWeekLabel(wk);
  
  // 기본값으로 오늘 설정
  const today = new Date();
  const tzoffset = today.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
  
  document.getElementById('permStart').value = localISOTime;
  document.getElementById('permEnd').value = localISOTime;
  
  document.getElementById('permModal').classList.add('show');
}

async function submitPermModal() {
  const st = document.getElementById('permStart').value;
  const ed = document.getElementById('permEnd').value;
  
  if (!st || !ed) { toast('시작일과 종료일을 모두 선택해주세요.', 'err'); return; }
  if (st > ed) { toast('종료일은 시작일 이후여야 합니다.', 'err'); return; }
  
  // expires_at은 종료일의 자정 직전 (23:59:59)으로 설정
  const starts_at = st + ' 00:00:00';
  const expires_at = ed + ' 23:59:59';
  
  showActionLoader('수정 권한 부여 중...');
  try {
    await api('/api/permissions', {
      method: 'POST',
      body: JSON.stringify({
        member_name: permTargetName,
        week_key: permTargetWeek,
        starts_at: starts_at,
        expires_at: expires_at
      })
    });
    toast(`✅ ${permTargetName}님에게 수정 권한이 부여되었습니다.`, 'ok');
    closeModal('permModal');
    // 권한 목록 갱신 — 탭이 보이는 중이면 즉시, 아니면 다음 진입 때 lazy 재조회.
    // (기존 classList.contains('active') 조건은 aTab 이 display 로 토글해서 항상 false 였음)
    _permsLoaded = false;
    if (document.getElementById('tabMembers')?.style.display !== 'none') {
      loadPermissions(true);
    }
  } catch(e) {
    toast('권한 부여 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  데이터 마이그레이션
// ═══════════════════════════════════════
async function exportData() {
  try {
    const data = await api('/api/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    a.download = `weekly_report_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    toast('✅ 데이터 내보내기 완료', 'ok');
  } catch (e) {
    toast('내보내기 실패: ' + e.message, 'err');
  }
}

async function importToServer(event) {
  const file = event.target.files[0];
  if (!file) return;
  showActionLoader('데이터 가져오는 중...');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    toast(`✅ 가져오기 완료: ${orgLabel('member')} ${res.imported.members}명, PIN ${res.imported.pins}개, 보고 ${res.imported.reports}건`, 'ok');
    await loadMembers();
  } catch (e) {
    toast('가져오기 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
  event.target.value = '';
}

// ═══════════════════════════════════════
//  운영 지표 차트 (SOR / SOP / CHG)
// ═══════════════════════════════════════
let _metricsChart = null;
let _metricsTab  = 'total';  // 'total' | 'member'
let _metricsView = 'chart';  // 'chart' | 'count'
let _metricsData = null;
let _metricsOpen = false;    // 기본 접힘 (chev 초기값 ▼ 와 매칭)

function toggleMetricsPanel() {
  _metricsOpen = !_metricsOpen;
  const body = document.getElementById('metricsBody');
  const controls = document.getElementById('metricsControls');
  const chev = document.getElementById('metricsChev');
  if (body)     body.style.display     = _metricsOpen ? '' : 'none';
  if (controls) controls.style.display = _metricsOpen ? 'flex' : 'none';
  // chev: 접힘 ▼(0deg), 펼침 ▲(180deg). 사용자 직관과 매칭.
  if (chev) chev.style.transform = _metricsOpen ? 'rotate(180deg)' : '';
  if (_metricsOpen && _metricsData) _renderMetrics();
}

function setMetricsTab(tab) {
  _metricsTab = tab;
  ['total', 'member'].forEach(t => {
    const btn = document.getElementById(`metricsTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (!btn) return;
    btn.style.background = t === tab ? 'var(--brand-600)' : 'var(--surface2)';
    btn.style.color      = t === tab ? '#fff' : 'var(--text2)';
  });
  if (_metricsData) _renderMetrics();
}

function setMetricsView(view) {
  _metricsView = view;
  ['chart', 'count'].forEach(v => {
    const btn = document.getElementById(`metricsView${v.charAt(0).toUpperCase() + v.slice(1)}`);
    if (!btn) return;
    btn.style.background = v === view ? 'var(--brand-600)' : 'var(--surface2)';
    btn.style.color      = v === view ? '#fff' : 'var(--text2)';
  });
  const chartWrap = document.getElementById('metricsChartWrap');
  const countWrap = document.getElementById('metricsCountWrap');
  if (chartWrap) chartWrap.style.display = view === 'chart' ? '' : 'none';
  if (countWrap) countWrap.style.display = view === 'count' ? '' : 'none';
  if (_metricsData) _renderMetrics();
}

async function loadMetrics() {
  const weeks = document.getElementById('metricsWeeksSel')?.value || 8;
  try {
    _metricsData = await api(`/api/reports/metrics?weeks=${weeks}`);
    if (_metricsOpen) _renderMetrics();
  } catch (e) {
    console.error('메트릭 로드 실패:', e);
  }
}

function _renderMetrics() {
  if (_metricsView === 'chart') renderMetricsChart(_metricsData);
  else renderMetricsCount(_metricsData);
}

// ── 건수 뷰 ──
function renderMetricsCount(data) {
  const wrap = document.getElementById('metricsCountWrap');
  const emptyEl = document.getElementById('metricsEmpty');
  if (!wrap) return;

  const weeks = (data.weeks || []).slice().reverse(); // 최신 주차 위로
  const hasData = weeks.some(wk => {
    const t = data.weekly_totals?.[wk];
    return t && (t.sor + t.sop + t.chg > 0);
  });

  if (!hasData) {
    wrap.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  if (_metricsTab === 'total') {
    const rows = weeks.map(wk => {
      const t = data.weekly_totals?.[wk] || { sor:0, sop:0, chg:0 };
      const total = t.sor + t.sop + t.chg;
      const label = wk.replace(/(\d{4})-W(\d+)/, '$1년 $2주');
      return `<tr>
        <td style="padding:7px 12px;font-size:12px;color:var(--text2)">${label}</td>
        <td style="padding:7px 12px;text-align:center;font-weight:700;color:#5b82f6">${t.sor}</td>
        <td style="padding:7px 12px;text-align:center;font-weight:700;color:#10b981">${t.sop}</td>
        <td style="padding:7px 12px;text-align:center;font-weight:700;color:#f59e0b">${t.chg}</td>
        <td style="padding:7px 12px;text-align:center;font-weight:800;color:var(--text)">${total}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="padding:7px 12px;text-align:left;font-size:11px;color:var(--text2);font-weight:600">주차</th>
        <th style="padding:7px 12px;text-align:center;font-size:11px;color:#5b82f6;font-weight:600">SOR</th>
        <th style="padding:7px 12px;text-align:center;font-size:11px;color:#10b981;font-weight:600">SOP</th>
        <th style="padding:7px 12px;text-align:center;font-size:11px;color:#f59e0b;font-weight:600">CHG</th>
        <th style="padding:7px 12px;text-align:center;font-size:11px;color:var(--text2);font-weight:600">합계</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } else {
    // 팀원별
    const mems = data.members || [];
    if (!mems.length) {
      wrap.innerHTML = `<p style="text-align:center;color:var(--text3);font-size:13px;padding:24px">운영 데이터 있는 ${olj('member','이')} 없습니다</p>`;
      return;
    }
    const cols = weeks.map(wk => `<th style="padding:7px 8px;text-align:center;font-size:10px;color:var(--text2);font-weight:600;min-width:50px">${wk.replace(/\d{4}-W/,'W')}</th>`).join('');
    const rows = mems.map(m => {
      const cells = weeks.map(wk => {
        const w = m.weeks?.[wk] || {sor:0,sop:0,chg:0};
        const tot = w.sor+w.sop+w.chg;
        return `<td style="padding:7px 8px;text-align:center;font-size:12px;font-weight:${tot?'700':'400'};color:${tot?'var(--text)':'var(--text3)'}">${tot||'–'}</td>`;
      }).join('');
      return `<tr><td style="padding:7px 12px;font-size:12px;white-space:nowrap">${esc(m.name)}</td>${cells}</tr>`;
    }).join('');
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="padding:7px 12px;text-align:left;font-size:11px;color:var(--text2);font-weight:600">${orgLabel('member')}</th>${cols}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
}

function renderMetricsChart(data) {
  const canvas  = document.getElementById('metricsChart');
  const emptyEl = document.getElementById('metricsEmpty');
  if (!canvas) return;

  const weeks = data.weeks || [];
  const labels = weeks.map(wk => {
    // "2026-W18" → "W18" 표시
    const m = wk.match(/W(\d+)/);
    return m ? `W${m[1]}` : wk;
  });

  // 전체 데이터가 0인지 확인
  const hasData = weeks.some(wk => {
    const t = data.weekly_totals?.[wk];
    return t && (t.sor + t.sop + t.chg > 0);
  });

  if (!hasData) {
    canvas.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  canvas.style.display = '';
  if (emptyEl) emptyEl.style.display = 'none';

  // 기존 차트 제거
  if (_metricsChart) { _metricsChart.destroy(); _metricsChart = null; }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#a0aec0' : '#718096';

  let datasets;

  if (_metricsTab === 'total') {
    // 팀 전체 — 주차별 SOR/SOP/CHG 스택 막대
    datasets = [
      {
        label: 'SOR',
        data: weeks.map(wk => data.weekly_totals?.[wk]?.sor || 0),
        backgroundColor: 'rgba(47,91,234,0.75)',
        borderRadius: 4,
        stack: 'ops',
      },
      {
        label: 'SOP',
        data: weeks.map(wk => data.weekly_totals?.[wk]?.sop || 0),
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderRadius: 4,
        stack: 'ops',
      },
      {
        label: 'CHG',
        data: weeks.map(wk => data.weekly_totals?.[wk]?.chg || 0),
        backgroundColor: 'rgba(245,158,11,0.75)',
        borderRadius: 4,
        stack: 'ops',
      },
    ];
  } else {
    // 팀원별 — 각 멤버를 다른 색상으로
    const palette = [
      'rgba(47,91,234,0.8)', 'rgba(16,185,129,0.8)', 'rgba(245,158,11,0.8)',
      'rgba(239,68,68,0.8)', 'rgba(167,139,250,0.8)', 'rgba(251,146,60,0.8)',
    ];
    const members = data.members || [];
    if (members.length === 0) {
      canvas.style.display = 'none';
      if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = `운영(SOR/SOP/CHG) 데이터가 있는 ${olj('member','이')} 없습니다`; }
      return;
    }
    datasets = members.map((m, i) => ({
      label: m.name,
      data: weeks.map(wk => {
        const w = m.weeks?.[wk];
        return w ? (w.sor + w.sop + w.chg) : 0;
      }),
      backgroundColor: palette[i % palette.length],
      borderRadius: 4,
      stack: 'member',
    }));
  }

  _metricsChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: textColor, font: { size: 11 }, boxWidth: 12, padding: 10 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}건`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 11 } },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: {
            color: textColor, font: { size: 11 },
            stepSize: 1,
            callback: v => Number.isInteger(v) ? v + '건' : '',
          },
        },
      },
    },
  });
}
