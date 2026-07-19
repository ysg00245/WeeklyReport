// ═══════════════════════════════════════
//  배너 + 마감 카운트다운
// ═══════════════════════════════════════
let _deadlineInfo = null;
let _deadlineTimer = null;

// ── 내 보고 캐시 (32차) ──
// renderWriteForm / updateBanner 가 같은 주차 보고를 각자 조회하던 이중 왕복 제거.
// 항상 Promise.all 로 함께 불려서 로그인·주차변경·저장마다 /api/reports/my 가 2번 나갔다.
// 무효화: 저장/초기화 성공 + WS(REPORT_STATUS_CHANGED·REPORT_DELETED) 수신 시.
let _myReportCache = {};    // { week_key: Promise<report|null> }
let _historyDirty = true;   // 이력 탭 재조회 필요 여부
let _historyData = null;
function fetchMyReport(week) {
  if (!_myReportCache[week]) {
    const p = api(`/api/reports/my?week=${encodeURIComponent(week)}`);
    _myReportCache[week] = p;
    p.catch(() => { if (_myReportCache[week] === p) delete _myReportCache[week]; });  // 실패는 캐시 안함
  }
  return _myReportCache[week];
}
function invalidateMyReport() { _myReportCache = {}; _historyDirty = true; }

// 보고 폼 푸터의 라벨은 사이드 "마감 안내" 카드와 중복되어 혼란을 유발하므로 제거.
// 환경설정의 마감 시점(deadline_at)은 사이드 카드 + 상단 배너(24h 이내) 에서만 표시.
function formatReportDayLabel() { return ''; }

async function updateBanner() {
  // 페이지 헤드 부제: 주차 라벨 · 범위
  const subEl = document.getElementById('pageSubtitle');
  if (subEl) {
    const past = currentWriteWeek !== CW ? ' (과거 작성 모드)' : '';
    subEl.textContent = `${getWeekLabel(currentWriteWeek)} · ${weekRange(currentWriteWeek)}${past}`;
  }

  // 사이드 사용자 정보 카드
  const avaEl = document.getElementById('sideAvatar');
  const nameEl = document.getElementById('sideName');
  const roleEl = document.getElementById('sideRole');
  const projEl = document.getElementById('sideProject');
  const weekEl = document.getElementById('sideWeek');
  const statusEl = document.getElementById('sideStatus');
  if (avaEl && user) {
    applyAvatarEl(avaEl, user.name);
  }
  if (nameEl) nameEl.textContent = user?.name || '-';
  if (roleEl) {
    // 사이드바 팀원 카드는 메인 role(개발/운영/기타) 표시 — 주간보고 카드의 sub_role과 구분
    const role = getRole(user?.name);
    const roleKr = role === 'dev' ? '개발' : role === 'ops' ? '운영' : '기타';
    roleEl.textContent = [user?.position, roleKr].filter(Boolean).join(' · ') || '-';
  }
  if (projEl) projEl.textContent = user?.project || '-';
  if (weekEl) weekEl.textContent = getWeekLabel(currentWriteWeek);

  // 호환용 (기존 hidden div도 채워둠)
  const oldT = document.getElementById('bannerTitle');
  const oldS = document.getElementById('bannerSub');
  const oldSt = document.getElementById('bannerStatus');
  if (oldT) oldT.textContent = `📅 ${getWeekLabel(currentWriteWeek)} 주간보고`;
  if (oldS) oldS.textContent = weekRange(currentWriteWeek);

  // 제출 상태 표시 — renderWriteForm 과 캐시 공유 (동일 주차 이중 조회 제거)
  try {
    const r = await fetchMyReport(currentWriteWeek);
    if (statusEl) {
      statusEl.innerHTML = r
        ? `<span style="color:var(--success)">✅ 제출됨</span>`
        : `<span style="color:var(--warn)">⏳ 미제출</span>`;
    }
    if (oldSt) oldSt.innerHTML = r
      ? `<span style="color:var(--success)">✅ 제출 완료</span><br><span>${r.submitted_at}</span>`
      : `<span style="color:var(--warn)">⏳ 미제출</span>`;
  } catch {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--warn)">⏳ 미제출</span>`;
    if (oldSt) oldSt.innerHTML = `<span style="color:var(--warn)">⏳ 미제출</span>`;
  }

  // 마감 정보 로드
  await updateDeadlineDisplay();
}

async function updateDeadlineDisplay() {
  const sideBox = document.getElementById('sideDeadlineBox');
  // 항상 기존 타이머 정리 (state 전환 시 leak 방지)
  if (_deadlineTimer) { clearInterval(_deadlineTimer); _deadlineTimer = null; }
  try {
    _deadlineInfo = await api(`/api/settings/deadline/info?week=${currentWriteWeek}`);
    // 보고 폼 푸터의 보고일자 라벨 갱신 (renderWriteForm 시점에 _deadlineInfo가 아직 없을 수 있어 사후 보정)
    const footerEl = document.getElementById('formFooterDeadline');
    if (footerEl) footerEl.textContent = formatReportDayLabel();

    const permRecord = (currentWriteWeek !== CW) ? userPermDetails[currentWriteWeek] : null;
    let permLive = false; // 권한이 살아있는 경우만 카운트다운 필요
    if (permRecord) {
      const exp = new Date(permRecord.expires_at.replace(' ', 'T') + '+09:00');
      permLive = exp > new Date();
    }

    // 마감 비활성 + 과거 주차 권한도 없으면 배너 숨김
    if (!_deadlineInfo.enabled && !permRecord) {
      if (sideBox) sideBox.style.display = 'none';
      const urg = document.getElementById('deadlineUrgent');
      if (urg) urg.style.display = 'none';
      return;
    }

    renderDeadlineCountdown();
    // 타이머 — 권한 카운트다운 진행 중이거나, 현재 주차 마감 미경과인 경우만
    const needTimer = permLive || (_deadlineInfo.enabled && !_deadlineInfo.is_passed);
    if (needTimer) {
      _deadlineTimer = setInterval(renderDeadlineCountdown, 1000);
    }
  } catch (e) {
    if (sideBox) sideBox.style.display = 'none';
    console.error('마감 정보 로드 실패:', e);
  }
}

function renderDeadlineCountdown() {
  const box      = document.getElementById('sideDeadlineBox');
  const mainEl   = document.getElementById('sideDeadlineMain');
  const subEl    = document.getElementById('sideDeadlineSub');
  const sideCard = document.getElementById('sideDeadlineCard');
  const urgent   = document.getElementById('deadlineUrgent');
  const duTitle  = document.getElementById('duTitle');
  const duSub    = document.getElementById('duSub');
  if (!urgent) return;

  // 헬퍼: 상단 배너 설정
  function setUrgent(cls, title, subHtml) {
    urgent.className = `deadline-urgent fade-up${cls ? ' ' + cls : ''}`;
    urgent.style.display = '';
    if (duTitle) duTitle.textContent = title;
    if (duSub)   duSub.innerHTML = subHtml;
    if (sideCard) sideCard.style.display = 'none';
    if (box)     box.style.display = 'none';
  }

  // ── Case A: 과거 주차 + 관리자 부여 수정기한 (deadline 비활성 상태에서도 표시) ──
  if (currentWriteWeek !== CW && userPermDetails[currentWriteWeek]) {
    const perm      = userPermDetails[currentWriteWeek];
    const expiresAt = new Date(perm.expires_at.replace(' ', 'T') + '+09:00');
    const permDiff  = expiresAt - new Date();
    const expiresStr = perm.expires_at.slice(5, 16);

    if (permDiff > 0) {
      const h = Math.floor(permDiff / 3600000);
      const m = Math.floor((permDiff % 3600000) / 60000);
      const s = Math.floor((permDiff % 60000) / 1000);
      const timeStr = h > 0 ? `${h}시간 ${m}분 ${s}초 남음` : `${m}분 ${s}초 남음`;
      setUrgent('perm', '✍️ 추가 수정 기한 부여됨',
        `${esc(expiresStr)} 까지 — <strong>${esc(timeStr)}</strong>`);
      // 타이머는 updateDeadlineDisplay에서 일괄 관리
    } else {
      setUrgent('passed', '🔒 추가 수정 기한 만료', `${esc(expiresStr)} 에 만료됨`);
      // 만료된 시점부터는 갱신 불필요 → 타이머 중단
      if (_deadlineTimer) { clearInterval(_deadlineTimer); _deadlineTimer = null; }
    }
    return;
  }

  // ── Case B: 기본 마감 기준 (마감 기능 비활성 시 배너 숨김) ──
  if (!_deadlineInfo || !_deadlineInfo.enabled || !_deadlineInfo.deadline_at) {
    urgent.style.display = 'none';
    if (sideCard) sideCard.style.display = 'none';
    if (box) box.style.display = 'none';
    return;
  }
  const deadlineAt = new Date(_deadlineInfo.deadline_at.replace(' ', 'T') + '+09:00');
  const diff       = deadlineAt - new Date();
  const dateStr    = _deadlineInfo.deadline_at.slice(5, 16);

  if (diff <= 0) {
    // 마감 완료 → 상단에 회색 잠금 배너
    setUrgent('passed', '🔒 보고 마감 완료', `${esc(dateStr)} 에 마감됨`);
    if (_deadlineTimer) { clearInterval(_deadlineTimer); _deadlineTimer = null; }
    _deadlineInfo.is_passed = true;
    return;
  }

  // 카운트다운 텍스트
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  let timeStr = '';
  if (d > 0) timeStr = `D-${d} · ${h}시간 ${m}분 남음`;
  else if (h > 0) timeStr = `${h}시간 ${m}분 ${s}초 남음`;
  else timeStr = `${m}분 ${s}초 남음`;

  const isUrgent = diff < 86400000; // 24h 이내

  if (isUrgent) {
    // 24h 이내: 상단 빨간 경고 배너
    const title = diff < 3600000 ? '⚠ 마감 임박 (1시간 이내)' : '⚠ 마감일자 오늘까지';
    setUrgent('', title, `${esc(dateStr)} 까지 — <strong>${esc(timeStr)}</strong>`);
  } else {
    // 24h 초과: 사이드 카드만, 상단 배너 숨김
    urgent.style.display = 'none';
    if (sideCard) sideCard.style.display = '';
    if (box) {
      box.style.display = '';
      box.classList.remove('urgent');
      if (mainEl) mainEl.textContent = `${dateStr} 까지`;
      if (subEl)  subEl.textContent  = timeStr + (_deadlineInfo.is_holiday_adjusted ? ' (공휴일 조정)' : '');
    }
  }
}

// ═══════════════════════════════════════
//  사용자 탭
// ═══════════════════════════════════════
function uTab(tab, el) {
  document.querySelectorAll('#pgUser .tab-new, #pgUser .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('tabWrite').style.display   = tab === 'write'   ? '' : 'none';
  document.getElementById('tabHistory').style.display = tab === 'history' ? '' : 'none';
  if (tab === 'write') renderWriteForm();
  if (tab === 'history') renderHistory();
}

// ═══════════════════════════════════════
//  보고 양식
// ═══════════════════════════════════════
function getRole(n) {
  const m = members.find(x => x.name === n);
  return m ? m.role : 'etc';
}
function getPosition(n) {
  const m = members.find(x => x.name === n);
  return m ? m.position : '';
}
function roleBadge(r) {
  if (r==='dev') return '<span class="rbadge rb-dev">개발</span>';
  if (r==='ops') return '<span class="rbadge rb-ops">운영</span>';
  return '<span class="rbadge rb-etc">기타</span>';
}
function positionBadge(p) {
  if (!p) return '';
  return `<span class="rbadge" style="background:rgba(167,139,250,.12);color:#a78bfa;margin-left:4px">${p}</span>`;
}
function locationBadge(l) {
  if (!l) return '';
  return `<span class="rbadge" style="background:rgba(156,163,175,.15);color:var(--text2);margin-left:4px">${l}</span>`;
}
function projectBadge(p) {
  if (!p) return '';
  return `<span class="rbadge" style="background:rgba(59,130,246,.15);color:#3b82f6;margin-left:4px">${p}</span>`;
}

function field(id, label, tagCls, tagTxt, val, ph, optional = false) {
  const v = val || '';
  const reqMark = optional ? ' <span style="color:var(--text2);font-weight:500">(선택)</span>' : ' <span style="color:var(--danger)">*</span>';
  // 지난주 같은 칸에 작성 내용이 있으면 '꾹 눌러 지난주 미리보기' 버튼 노출
  const lwVal = lastWeekFieldValue(id.replace(/^f_/, ''));
  const peekBtn = (lwVal && lwVal.trim())
    ? `<button type="button" class="peek-last-btn"
         onmousedown="peekLastWeek(event,'${id}')" onmouseup="unpeekLastWeek('${id}')" onmouseleave="unpeekLastWeek('${id}')"
         ontouchstart="peekLastWeek(event,'${id}')" ontouchend="unpeekLastWeek('${id}')" ontouchcancel="unpeekLastWeek('${id}')"
         title="누르고 있는 동안 지난주 작성 내용을 미리봅니다">👁 지난주</button>`
    : '';
  return `<div class="field-new">
    <div class="field-label-row">
      <label class="label-new" for="${id}">${esc(label)}${reqMark}</label>
      ${peekBtn}
    </div>
    <textarea class="textarea-new" id="${id}" placeholder="${esc(ph)}" oninput="updateChar(this,'ch_${id}')">${esc(v)}</textarea>
    <div class="field-hint"><span id="ch_${id}">${v.length}</span>자${optional ? '' : ' · 명사형 종결 권장 (예: "결제 모듈 리팩토링 완료")'}</div>
  </div>`;
}

// 이전 주차 키 계산 (currentWriteWeek 기준 -1주)
function prevWeekKey(key) {
  const mon = weekMonday(key);
  mon.setDate(mon.getDate() - 7);
  return getWeekKey(mon);
}

// 지난 주 보고 불러오기
async function loadLastWeekReport() {
  const prevWeek = prevWeekKey(currentWriteWeek);

  // 현재 폼에 내용이 있으면 확인
  // (기 제출된 보고서 로드 상태 OR 직접 입력해서 dirty된 상태)
  const hasExisting = !!(_currentReport && _currentReport.submitted_at);
  const isDirty = _initialFormHash !== getFormHash();
  if (hasExisting || isDirty) {
    if (!confirm(`지난주 '다음 주 계획'을 이번 주 '완료' 칸으로 옮기고, 나머지 칸은 비웁니다.\n현재 작성 중인 내용은 사라집니다. 진행할까요?`)) return;
  }

  showActionLoader('지난 주 보고 불러오는 중...');
  try {
    const r = await api(`/api/reports/my?week=${prevWeek}`);
    if (!r) {
      toast(`${getWeekLabel(prevWeek)} 보고가 없습니다`, 'err');
      return;
    }

    const role = getRole(user?.name);
    const schema = (globalSettings.roles_schema && globalSettings.roles_schema[role])
      ? globalSettings.roles_schema[role] : null;

    // 지난주 '다음 주 계획(plan)' → 이번 주 '완료(done)' 로 이동. 그 외 칸·카운터는 모두 비움.
    const lastPlan = (r.custom_data && r.custom_data.plan !== undefined) ? r.custom_data.plan : (r.plan || '');

    if (schema) {
      schema.forEach(f => {
        if (f.type === 'counter') {
          const el = document.getElementById(`cnt_${f.id}`);
          if (el) { el.textContent = '0'; el.className = 'cnt-val-new'; }
        } else if (f.type === 'textarea') {
          const el = document.getElementById(`f_${f.id}`);
          if (!el) return;
          el.value = (f.id === 'done') ? (lastPlan || '') : '';
          updateChar(el, 'ch_' + el.id);
        }
      });
    } else {
      // 레거시 폼 — done 에만 지난주 plan 이동, 나머지 비움
      [['f_done', lastPlan || ''], ['f_plan', ''], ['f_issue', ''], ['f_note', '']]
        .forEach(([id, val]) => {
          const el = document.getElementById(id);
          if (el) { el.value = val; updateChar(el, 'ch_' + id); }
        });
      // 운영 카운터 리셋
      ['sor', 'sop', 'chg'].forEach(key => {
        const el = document.getElementById(`cnt_${key}`);
        if (el) { el.textContent = '0'; el.className = 'cnt-val-new'; }
      });
    }

    toast(`✅ 지난주 '다음 주 계획'을 이번 주 '완료'로 옮겼습니다`, 'ok');
    updateAiAssistBtnState();
  } catch (e) {
    toast('불러오기 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ── 지난주 내용 '꾹 눌러 미리보기' (각 입력칸) ──
let _lastWeekReport = null;       // 지난 주 보고 캐시 (renderWriteForm 에서 prefetch)
const _peekRestore = {};          // {textareaId: {value, readOnly}} — 미리보기 전 현재 값 저장

// 지난 주 보고에서 해당 필드(fid) 값 추출 (custom_data 우선, 레거시 컬럼 폴백)
function lastWeekFieldValue(fid) {
  if (!_lastWeekReport) return '';
  const cd = _lastWeekReport.custom_data;
  const v = (cd && cd[fid] !== undefined) ? cd[fid] : _lastWeekReport[fid];
  return (v === undefined || v === null) ? '' : String(v);
}

// 버튼을 누르는 동안: textarea 에 지난주 내용을 읽기전용으로 표시
function peekLastWeek(ev, taId) {
  if (ev && ev.preventDefault) ev.preventDefault();   // 포커스 가로채기 / 터치 스크롤 방지
  const ta = document.getElementById(taId);
  if (!ta || ta.disabled || _peekRestore[taId] !== undefined) return; // 잠금/중복 방지
  const lwVal = lastWeekFieldValue(taId.replace(/^f_/, ''));
  _peekRestore[taId] = { value: ta.value, readOnly: ta.readOnly };
  ta.value = lwVal || '(지난주 작성 내용 없음)';
  ta.readOnly = true;
  ta.classList.add('peeking');
}

// 버튼에서 손을 떼면: 원래 입력 내용으로 복원
function unpeekLastWeek(taId) {
  const ta = document.getElementById(taId);
  const saved = _peekRestore[taId];
  if (!ta || saved === undefined) return;
  ta.value = saved.value;
  ta.readOnly = saved.readOnly;
  ta.classList.remove('peeking');
  delete _peekRestore[taId];
}

// 현재 보고 캐시 (폼 렌더링용)
let _currentReport = null;
let currentWriteWeek = '';
let userAllowedWeeks = [];
let userPermDetails  = {}; // {week_key: {starts_at, expires_at}}

async function fetchUserPermissions() {
  currentWriteWeek = CW; // 초기화
  try {
    const [weeks, details] = await Promise.all([
      api(`/api/permissions/${encodeURIComponent(user.name)}`),
      api(`/api/permissions/${encodeURIComponent(user.name)}/detail`),
    ]);
    userAllowedWeeks = weeks;
    userPermDetails  = {};
    for (const d of details) userPermDetails[d.week_key] = d;
    populateUserWeekSel();
  } catch (e) {
    console.error('권한 조회 실패', e);
  }
}

function populateUserWeekSel() {
  const wrap = document.getElementById('userWeekWrapper');
  const sel = document.getElementById('userWeekSel');
  if (!wrap || !sel) return; // 요소를 찾지 못한 경우 (Admin 뷰 등) 예방
  if (!userAllowedWeeks || userAllowedWeeks.length === 0) {
    wrap.style.display = 'none';
    currentWriteWeek = CW;
    return;
  }
  wrap.style.display = 'block';
  sel.innerHTML = '';
  const opts = [CW, ...userAllowedWeeks];
  // 중복 제거 및 정렬
  const uniqueOpts = [...new Set(opts)].sort((a, b) => b.localeCompare(a));
  
  uniqueOpts.forEach(k => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = getWeekLabel(k) + (k === CW ? ' (이번 주)' : '');
    if (k === currentWriteWeek) o.selected = true;
    sel.appendChild(o);
  });
}

async function changeWriteWeek() {
  const sel = document.getElementById('userWeekSel');
  if (sel) {
    showActionLoader('데이터 불러오는 중...');
    currentWriteWeek = sel.value;
    try {
      await Promise.all([
        updateBanner(),
        renderWriteForm()
      ]);
    } finally {
      hideActionLoader();
    }
  }
}

let _initialFormHash = '';
function getFormHash() {
  let hash = '';
  document.querySelectorAll('#reportForm textarea').forEach(t => hash += t.id + ':' + t.value + '|');
  document.querySelectorAll('#reportForm .cnt-val').forEach(c => hash += c.id + ':' + c.textContent + '|');
  return hash;
}

async function renderWriteForm() {
  if (!currentWriteWeek) currentWriteWeek = CW;
  // 최종 취합 카드는 결재권자(팀장) 세션에서만 노출 (일반 팀원 제외)
  const _fmCard = document.getElementById('finalMergeCard');
  if (_fmCard) _fmCard.style.display = (typeof isApprover !== 'undefined' && isApprover) ? '' : 'none';
  const role = getRole(user?.name);
  let ex = {};
  // 현재 주차 보고 + 지난 주 보고를 병렬 prefetch
  // (지난주 데이터는 '꾹 눌러 미리보기' 버튼이 즉시 동작하도록 캐시)
  const _prevWk = prevWeekKey(currentWriteWeek);
  const [curRes, lwRes] = await Promise.allSettled([
    fetchMyReport(currentWriteWeek),
    fetchMyReport(_prevWk),
  ]);
  if (curRes.status === 'fulfilled' && curRes.value) ex = curRes.value;
  _lastWeekReport = (lwRes.status === 'fulfilled' && lwRes.value) ? lwRes.value : null;
  _currentReport = ex;

  let fields = '';
  const schema = (globalSettings.roles_schema && globalSettings.roles_schema[role]) ? globalSettings.roles_schema[role] : null;

  if (schema) {
    // 동적 폼 렌더링
    let countersHtml = '';
    let textareasHtml = '';

    schema.forEach(f => {
      const val = ex.custom_data && ex.custom_data[f.id] !== undefined ? ex.custom_data[f.id] : (ex[f.id] || '');

      if (f.type === 'counter') {
        countersHtml += counter(f.id, f.label, f.desc || '', parseInt(val) || 0, f.color || '#3b82f6');
      } else if (f.type === 'textarea') {
        textareasHtml += field(`f_${f.id}`, f.label, `ft-${f.id}`, f.tag || f.label.substring(0,2), val, f.placeholder || '', !f.required);
      }
    });

    if (countersHtml) {
      fields += `<div class="field-new"><label class="label-new">이번 주 수치 항목</label><div class="counter-row-new">${countersHtml}</div></div>`;
    }
    fields += textareasHtml;
  } else {
    // 레거시 폼 렌더링
    if (role === 'ops') {
      const sorCnt = parseInt(ex.sor_cnt || 0);
      const sopCnt = parseInt(ex.sop_cnt || 0);
      const chgCnt = parseInt(ex.chg_cnt || 0);
      fields = `
        <div class="fg">
          <div class="flabel">📋 이번 주 운영 처리 현황</div>
          <div class="counter-row">
            ${counter('sor', 'SOR', '운영 요청', sorCnt, '#a78bfa')}
            ${counter('sop', 'SOP', '표준 절차', sopCnt, '#f472b6')}
            ${counter('chg', '변경', '변경계획서', chgCnt, '#2dd4bf')}
          </div>
        </div>`
           + field('f_done','이번 주 완료','ft-done','완료', ex.done||'','완료한 업무를 입력하세요')
           + field('f_plan','다음 주 계획','ft-plan','계획', ex.plan||'','다음 주 업무 계획')
           + field('f_issue','이슈/요청','ft-issue','이슈', ex.issue||'','이슈 또는 협조 요청', true)
           + field('f_note','특이사항','ft-note','특이', ex.note||'','특이사항', true);
    } else {
      fields = field('f_done','이번 주 완료','ft-done','완료', ex.done||'','완료한 업무를 입력하세요')
             + field('f_plan','다음 주 계획','ft-plan','계획', ex.plan||'','다음 주 업무 계획')
             + field('f_issue','이슈/요청','ft-issue','이슈', ex.issue||'','이슈 또는 협조 요청', true)
             + field('f_note','특이사항','ft-note','특이', ex.note||'','특이사항', true);
    }
  }

  // 마감 여부 확인 (활성 수정권한 보유 시 잠금 해제)
  const _permRecord = userPermDetails[currentWriteWeek];
  const hasPerm = _permRecord && (() => {
    try {
      const exp = new Date(_permRecord.expires_at.replace(' ', 'T') + '+09:00');
      return exp > new Date();
    } catch { return false; }
  })();
  const deadlinePassed = _deadlineInfo && _deadlineInfo.enabled && _deadlineInfo.is_passed;
  const isPastWeek = currentWriteWeek !== CW;
  const isLocked = (isPastWeek || deadlinePassed) && !hasPerm;

  const lockedHtml = isLocked ? `<div style="background:var(--danger-bg);border:1px solid color-mix(in oklab, var(--danger) 28%, transparent);border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:10px">
    <span style="font-size:18px">🔒</span>
    <div>
      <div style="font-weight:700;color:var(--danger);font-size:13px">마감되었습니다</div>
      <div style="font-size:12px;color:var(--text2);margin-top:2px">수정이 필요한 경우 관리자에게 권한을 요청해주세요.</div>
    </div>
  </div>` : '';

  // 카드 헤드 우측: 상태 배지만 (timestamp 는 별도 라인으로 — 모바일 헤더 두 줄 방지)
  const submittedAt = ex.submitted_at || '';
  let headRight;
  if (submittedAt && ex.status === 'needs_revision') {
    headRight = `<span class="badge-new warning" style="background:color-mix(in oklab, var(--warning) 16%, transparent);color:var(--warning);font-weight:700;white-space:nowrap">⚠️ 보완 요청됨</span>`;
  } else if (submittedAt) {
    headRight = `<span class="badge-new success" style="white-space:nowrap">✓ 제출 완료</span>`;
  } else {
    headRight = `<span class="badge-new" style="white-space:nowrap">⏳ 미제출</span>`;
  }

  // 저장 timestamp — 헤더 우측 (✓ 제출 완료 배지 아래)
  const tsRightLine = submittedAt
    ? `<div style="font-size:11px;color:var(--text3);margin-top:4px;text-align:right;white-space:nowrap">✓ 저장됨 · ${esc(submittedAt)}</div>`
    : '';

  // 보완 요청 상태면 카드 상단에 안내 배너 추가 — 사용자가 무엇을 해야 하는지 명시
  const reviseHtml = (submittedAt && ex.status === 'needs_revision')
    ? `<div style="background:color-mix(in oklab, var(--warning) 10%, transparent);border:1px solid color-mix(in oklab, var(--warning) 35%, transparent);border-left:4px solid var(--warning);border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;flex-shrink:0">⚠️</span>
        <div style="flex:1">
          <div style="font-weight:700;color:var(--warning);font-size:13px;margin-bottom:2px">관리자가 보완을 요청했습니다</div>
          <div style="font-size:12px;color:var(--text2);line-height:1.5">내용을 보완해서 다시 저장해주세요. 저장하면 자동으로 '제출 완료' 상태로 복원됩니다.</div>
        </div>
      </div>`
    : '';

  // 카드 부제: 세부역할 · 프로젝트 (sub_role 우선)
  const subRole = subRoleLabel(user.name);
  const cardSubText = [subRole, user.project].filter(Boolean).join(' · ');

  document.getElementById('reportForm').innerHTML = `
    <div class="card">
      <div class="card-head">
        <div style="min-width:0;flex:1">
          <div class="card-title">주간보고 작성</div>
          <div class="card-sub">${esc(cardSubText)}</div>
        </div>
        <!-- 우측: 제출 완료 배지 + timestamp (배지 아래 우측 정렬) -->
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0;flex-shrink:0">
          <div class="row-flex">${headRight}</div>
          ${tsRightLine}
        </div>
      </div>
      <div class="card-body">${reviseHtml}${lockedHtml}${fields}
        <div class="row-flex between" style="margin-top:8px;flex-wrap:wrap;gap:10px">
          <span id="formFooterDeadline" style="font-size:12px;color:var(--text2)">${esc(formatReportDayLabel())}</span>
          <div class="row-flex form-actions-row" style="gap:8px;flex-wrap:wrap">
            ${isLocked ? '' : (submittedAt ? `<button class="btn-new ghost" onclick="clearReport()">초기화</button>` : '')}
            <button class="btn-new ghost" onclick="loadLastWeekReport()">📋 지난 주 불러오기</button>
            ${isLocked ? '' : `<button class="btn-new primary" onclick="submitReport()">📤 ${submittedAt ? '수정 제출' : '제출하기'}</button>`}
          </div>
        </div>
        <!-- AI 작성 도우미 패널 -->
        <div id="aiAssistPanel" style="display:none">
          <div class="ai-assist-panel">
            <div class="ai-assist-hdr">
              <span class="ai-assist-hdr-title">✨ AI 작성 도우미</span>
              <button class="ai-assist-hdr-close" onclick="closeAiAssist()">✕</button>
            </div>
            <div class="ai-assist-body" id="aiAssistBody"></div>
          </div>
        </div>
      </div>
    </div>`;
  
  // 마감된 경우 입력 필드 비활성화
  if (isLocked) {
    document.querySelectorAll('#reportForm textarea').forEach(t => { t.disabled = true; t.style.opacity = '0.5'; });
    document.querySelectorAll('#reportForm .cnt-btn-new').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
  }

  // 초기 폼 상태 저장 (Dirty Check 용도)
  _initialFormHash = getFormHash();

  // AI 도움받기 버튼 초기 상태 + 입력 감지
  updateAiAssistBtnState();
  const formEl = document.getElementById('reportForm');
  if (formEl) formEl.addEventListener('input', updateAiAssistBtnState);
}

function updateChar(el, cid) { document.getElementById(cid).textContent = el.value.length + '자'; }
function gv(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function getCnt(key) { return parseInt(document.getElementById(`cnt_${key}`)?.textContent || 0); }

function counter(key, tag, label, val, color) {
  return `<div class="counter-item-new">
    <div class="counter-label-new">
      <span style="font-weight:700;color:${color}">${esc(tag)}</span>
      <span style="font-size:11px;color:var(--text2);font-weight:500">${esc(label)}</span>
    </div>
    <div class="counter-ctrl-new">
      <button type="button" class="cnt-btn-new" onclick="adjCnt('${key}',-1)">−</button>
      <span class="cnt-val-new ${val>0?'has':''}" id="cnt_${key}">${val}</span>
      <button type="button" class="cnt-btn-new" onclick="adjCnt('${key}',1)">+</button>
    </div>
  </div>`;
}
function adjCnt(key, delta) {
  const el = document.getElementById(`cnt_${key}`);
  if (!el) return;
  const next = Math.max(0, parseInt(el.textContent) + delta);
  el.textContent = next;
  el.className = 'cnt-val-new' + (next > 0 ? ' has' : '');
  updateAiAssistBtnState();
}

// ═══════════════════════════════════════
//  AI 작성 도우미
// ═══════════════════════════════════════
function updateAiAssistBtnState() {
  const btn = document.getElementById('aiAssistBtn');
  if (!btn) return;

  const role   = getRole(user?.name);
  const schema = (globalSettings?.roles_schema && globalSettings.roles_schema[role])
                  ? globalSettings.roles_schema[role] : null;

  let hasContent = false;
  if (schema) {
    hasContent = schema.some(f => {
      if (f.type === 'counter') {
        return parseInt(document.getElementById(`cnt_${f.id}`)?.textContent || '0') > 0;
      }
      return (gv(`f_${f.id}`) || '').length > 0;
    });
  } else {
    hasContent = ['f_done', 'f_plan', 'f_issue', 'f_note'].some(id => (gv(id) || '').length > 0);
  }

  btn.disabled = !hasContent;
}

async function requestAiAssist() {
  const panel  = document.getElementById('aiAssistPanel');
  const body   = document.getElementById('aiAssistBody');
  const btn    = document.getElementById('aiAssistBtn');
  if (!panel || !body) return;

  // 기존 인라인 제안 모두 제거
  document.querySelectorAll('.ai-field-suggestion').forEach(el => el.remove());

  // 현재 폼 데이터 수집
  const role   = getRole(user?.name);
  const schema = (globalSettings.roles_schema && globalSettings.roles_schema[role])
                  ? globalSettings.roles_schema[role] : null;
  let customData = {}, done = '', plan = '', issue = '', note = '';

  if (schema) {
    schema.forEach(f => {
      const val = f.type === 'counter' ? getCnt(f.id) : gv(`f_${f.id}`);
      customData[f.id] = val;
    });
  } else {
    done  = gv('f_done');
    plan  = gv('f_plan');
    issue = gv('f_issue');
    note  = gv('f_note');
  }

  // 내용 있는지 확인
  const hasContent = schema
    ? Object.values(customData).some(v => v && String(v).trim() && String(v) !== '0')
    : (done || plan);
  if (!hasContent) {
    toast('먼저 보고 내용을 입력해주세요.', 'warn');
    return;
  }

  // 패널 열고 로딩
  panel.style.display = '';
  body.innerHTML = `<div class="ai-assist-loading"><span class="spin"></span> AI가 초안을 분석하고 있습니다...</div>`;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 분석 중...'; }

  try {
    const res = await api('/api/ai/assist', {
      method: 'POST',
      body: JSON.stringify({
        member_name: user.name,
        week_key: currentWriteWeek,
        role,
        custom_data: customData,
        done, plan, issue, note
      })
    });

    // ── 피드백 패널 ──
    body.innerHTML = res.feedback
      ? md2html(res.feedback)
      : '<em style="color:var(--text2)">개선 제안 없음 — 보고가 잘 작성되어 있습니다!</em>';

    // ── 필드별 인라인 제안 주입 ──
    const suggestions = (res.suggestions && typeof res.suggestions === 'object') ? res.suggestions : {};
    let sugCount = 0;
    for (const [fieldId, sugText] of Object.entries(suggestions)) {
      if (!sugText || !String(sugText).trim()) continue;
      const ta = document.getElementById(`f_${fieldId}`);
      if (!ta) continue;

      // 기존 제안 중복 제거
      const prev = document.getElementById(`ai-sug-${fieldId}`);
      if (prev) prev.remove();

      // 제안 카드 DOM 생성
      const sugDiv = document.createElement('div');
      sugDiv.className = 'ai-field-suggestion';
      sugDiv.id = `ai-sug-${fieldId}`;
      sugDiv.dataset.suggestion = String(sugText);

      const hdr = document.createElement('div');
      hdr.className = 'ai-sug-hdr';

      const label = document.createElement('span');
      label.className = 'ai-sug-label';
      label.textContent = '✨ AI 제안';

      const btns = document.createElement('div');
      btns.className = 'ai-sug-btns';

      const applyBtn = document.createElement('button');
      applyBtn.className = 'ai-sug-apply';
      applyBtn.textContent = '✓ 적용';
      applyBtn.onclick = () => applyAiSuggestion(fieldId);

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'ai-sug-dismiss';
      dismissBtn.textContent = '✕';
      dismissBtn.onclick = () => dismissAiSuggestion(fieldId);

      btns.append(applyBtn, dismissBtn);
      hdr.append(label, btns);

      const textEl = document.createElement('div');
      textEl.className = 'ai-sug-text';
      textEl.textContent = String(sugText);   // textContent → 자동 이스케이프

      sugDiv.append(hdr, textEl);
      ta.insertAdjacentElement('afterend', sugDiv);
      sugCount++;
    }

  } catch (e) {
    body.innerHTML = `<span style="color:var(--danger)">분석 실패: ${esc(e.message)}</span>`;
  } finally {
    updateAiAssistBtnState();
    if (btn) btn.textContent = '✨ AI 피드백 받기';
  }
}

function applyAiSuggestion(fieldId) {
  const sugDiv = document.getElementById(`ai-sug-${fieldId}`);
  if (!sugDiv) return;
  const ta = document.getElementById(`f_${fieldId}`);
  if (ta) {
    ta.value = sugDiv.dataset.suggestion || '';
    // input 이벤트 발생 → 글자수, 해시, AI 버튼 상태 자동 갱신
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 더티 플래그 초기화 — 적용 후엔 무조건 "변경됨" 상태
    _initialFormHash = '';
  }
  // 적용됨 표시 후 자동 제거
  const applyBtn = sugDiv.querySelector('.ai-sug-apply');
  if (applyBtn) { applyBtn.textContent = '✓ 적용됨'; applyBtn.disabled = true; }
  const dismissBtn = sugDiv.querySelector('.ai-sug-dismiss');
  if (dismissBtn) dismissBtn.style.display = 'none';
  sugDiv.classList.add('ai-sug-applied');
  setTimeout(() => sugDiv.remove(), 1100);
}

function dismissAiSuggestion(fieldId) {
  const sugDiv = document.getElementById(`ai-sug-${fieldId}`);
  if (sugDiv) sugDiv.remove();
}

function closeAiAssist() {
  const panel = document.getElementById('aiAssistPanel');
  if (panel) panel.style.display = 'none';
  // 열려있는 인라인 제안도 함께 닫기
  document.querySelectorAll('.ai-field-suggestion').forEach(el => el.remove());
}

async function submitReport() {
  // ① 마감 여부 클라이언트 즉시 체크 (서버 왕복 없이 바로 피드백)
  const _permRec  = userPermDetails[currentWriteWeek];
  const _hasPerm  = _permRec && (() => {
    try { return new Date(_permRec.expires_at.replace(' ', 'T') + '+09:00') > new Date(); }
    catch { return false; }
  })();
  const _passed   = _deadlineInfo && _deadlineInfo.enabled && _deadlineInfo.is_passed;
  const _isPast   = currentWriteWeek !== CW;
  if ((_isPast || _passed) && !_hasPerm) {
    toast('마감된 주간보고입니다. 관리자에게 수정 권한을 요청해주세요.', 'err');
    return;
  }

  // ② 변경 내용 없음 체크 (마감 체크 통과 후)
  if (_initialFormHash === getFormHash()) {
    toast('변경된 내용이 없습니다.', 'ok');
    return;
  }

  // ③ 필드 유효성 검사 + 페이로드 구성
  const role = getRole(user?.name);
  const schema = (globalSettings.roles_schema && globalSettings.roles_schema[role]) ? globalSettings.roles_schema[role] : null;

  let payload = { week_key: currentWriteWeek, custom_data: {} };

  if (schema) {
    for (const f of schema) {
      let val = f.type === 'counter' ? getCnt(f.id) : gv(`f_${f.id}`);
      if (f.required && !val && val !== 0) {
        toast(`${f.label} 항목을 입력해주세요`, 'err'); return;
      }
      payload.custom_data[f.id] = val;
      // 레거시 필드 호환성
      if (['done', 'plan', 'issue', 'note', 'sor_cnt', 'sop_cnt', 'chg_cnt'].includes(f.id)) {
        payload[f.id] = val;
      }
    }
  } else {
    // 레거시 로직
    const done = gv('f_done'), plan = gv('f_plan');
    if (!done) { toast('완료 업무를 입력해주세요', 'err'); return; }
    if (!plan) { toast('다음 주 계획을 입력해주세요', 'err'); return; }
    payload = {
      week_key: currentWriteWeek,
      done, plan,
      issue: gv('f_issue'),
      note: gv('f_note'),
      sor_cnt: getCnt('sor'),
      sop_cnt: getCnt('sop'),
      chg_cnt: getCnt('chg'),
      custom_data: {}
    };
  }

  // 제출 진행 시각 피드백 — 로더 + 버튼 disable
  showActionLoader('주간보고 저장 중...');
  try {
    await api(`/api/reports/${encodeURIComponent(user.name)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    toast('✅ 주간보고가 저장되었습니다', 'ok');
    _initialFormHash = getFormHash();
    invalidateMyReport();   // 방금 저장 → 캐시 무효화 후 새 데이터로 렌더
    renderWriteForm();
    updateBanner();
    // 결재권자: 본인 보고 저장 → 다음 단계(최종 취합) 안내
    if (typeof isApprover !== 'undefined' && isApprover) {
      if (typeof _fmMyReport !== 'undefined') _fmMyReport = true;
      setTimeout(() => toast('📋 이제 [최종 취합본 만들기]로 보고서를 완성할 수 있어요!', 'ok'), 1600);
    }
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function clearReport() {
  if (!confirm('작성 내용을 초기화할까요?')) return;
  showActionLoader('보고 초기화 중...');
  try {
    await api(`/api/reports/my?week=${currentWriteWeek}`, { method: 'DELETE' });
    toast('🧹 작성 내용을 초기화했습니다', 'ok');
    invalidateMyReport();   // 방금 삭제 → 캐시 무효화 후 새 데이터로 렌더
    renderWriteForm();
    updateBanner();
  } catch (e) {
    toast('초기화 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  이력
// ═══════════════════════════════════════
async function renderHistory() {
  const list = document.getElementById('historyList');
  try {
    // 탭 토글마다 재조회하지 않음 — 내 보고가 바뀐 경우(_historyDirty)에만 재조회
    if (_historyDirty || !_historyData) {
      _historyData = await api(`/api/reports/my/history`);
      _historyDirty = false;
    }
    const history = _historyData;
    if (!history.length) {
      list.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><div class="empty-txt">아직 제출한 보고가 없습니다</div></div>`;
      return;
    }
    list.innerHTML = history.map(r => {
      const wk = r.week_key;
      const isCur = wk === CW;
      const hasCnt = r.sor_cnt || r.sop_cnt || r.chg_cnt;
      const cntSection = hasCnt ? `<div class="hs"><div class="hs-title">📋 운영 처리 현황</div><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:4px">
        ${r.sor_cnt ? `<span style="background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">SOR ${r.sor_cnt}건</span>` : ''}
        ${r.sop_cnt ? `<span style="background:rgba(244,114,182,.15);color:#f472b6;border:1px solid rgba(244,114,182,.3);padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">SOP ${r.sop_cnt}건</span>` : ''}
        ${r.chg_cnt ? `<span style="background:rgba(45,212,191,.15);color:#2dd4bf;border:1px solid rgba(45,212,191,.3);padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">변경 ${r.chg_cnt}건</span>` : ''}
      </div></div>` : '';
      const sections = cntSection + [
        ['✅ 완료',r.done],['📌 계획',r.plan],['⚠️ 이슈',r.issue],['🔔 특이사항',r.note]
      ].filter(([,v])=>v).map(([t,v])=>`<div class="hs"><div class="hs-title">${t}</div><div class="hs-val">${esc(v)}</div></div>`).join('');
      return `<div class="hist-card">
        <!-- 헤더 2줄: 1행 [주차+기간+이번주뱃지] 왼쪽 정렬 / 2행 [배지들·시간·▼] -->
        <!-- 기존 .hist-hdr CSS 의 space-between/center 정렬을 inline 으로 override (PC 가운데 정렬 방지) -->
        <div class="hist-hdr" onclick="togHist(this)" style="display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:4px;padding:10px 14px;text-align:left">
          <!-- 1행: 주차/기간/이번주뱃지 — 왼쪽 정렬 -->
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-start">
            <span class="hist-week" style="display:inline-block">${getWeekLabel(wk)}</span>
            <span style="font-size:11px;color:var(--text3);white-space:nowrap">${weekRange(wk)}</span>
            ${isCur?'<span style="font-size:10px;background:rgba(56,139,253,.15);color:var(--accent);padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap">이번 주</span>':''}
          </div>
          <!-- 2행: 배지(컴팩트) + 시간 + 우측 끝 ▼ -->
          <div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap;row-gap:4px;justify-content:flex-start">
            ${roleBadge(r.role||'etc')}${positionBadge(r.position||'')}${projectBadge(r.project||'')}
            <span style="font-size:11px;color:var(--text3);white-space:nowrap;margin-left:6px">📅 ${r.submitted_at}</span>
            <span class="chev" style="margin-left:auto;color:var(--text3);font-size:12px">▼</span>
          </div>
        </div>
        <div class="hist-body">
          ${sections}
          ${isCur?`<div style="margin-top:12px"><button class="btn btn-s btn-sm" onclick="document.querySelectorAll('#pgUser .tab')[0].click()">이번 주 수정</button></div>`:''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div><div class="empty-txt">이력 로드 실패</div></div>`;
  }
}

function togHist(h) {
  const b = h.nextElementSibling, c = h.querySelector('.chev');
  const o = b.classList.toggle('open');
  c.classList.toggle('open', o);
}
