let tSettings = { locations: [], projects: [], projectRoles: [], roles: {} };

function loadSettingsToEditor() {
  tSettings.locations = [...(globalSettings.locations_schema || [])];
  let rs = globalSettings.roles_schema;
  tSettings.projects = [...(globalSettings.projects_schema || [])];
  tSettings.projectRoles = [...(globalSettings.project_roles_schema || [])];
  // DB의 레거시 배열 구조를 객체 구조로 마이그레이션
  if (Array.isArray(rs)) {
    const newRs = { dev: [], ops: [], etc: [] };
    rs.forEach(r => {
      if (r.id && newRs[r.id] !== undefined) {
        newRs[r.id] = (r.fields || []).map(f => ({
          id: f.id,
          type: f.type || 'textarea',
          label: f.label || '',
          placeholder: f.placeholder || '',
          required: !(f.optional),
          color: f.color || ''
        }));
      }
    });
    rs = newRs;
  }
  // 딥 카피
  tSettings.roles = JSON.parse(JSON.stringify(rs || { dev: [], ops: [], etc: [] }));
  
  // 만약 양식이 완전히 비어있다면 디폴트 할당
  const defaults = {
    dev: [
      { id: 'done', type: 'textarea', label: '이번 주 완료', placeholder: '완료한 업무를 입력하세요', required: true },
      { id: 'plan', type: 'textarea', label: '다음 주 계획', placeholder: '다음 주 업무 계획', required: true },
      { id: 'issue', type: 'textarea', label: '이슈/요청', placeholder: '이슈 또는 협조 요청', required: false },
      { id: 'note', type: 'textarea', label: '특이사항', placeholder: '특이사항', required: false }
    ],
    ops: [
      { id: 'sor_cnt', type: 'counter', label: '운영 요청', color: '#a78bfa' },
      { id: 'sop_cnt', type: 'counter', label: '표준 절차', color: '#f472b6' },
      { id: 'chg_cnt', type: 'counter', label: '변경계획서', color: '#2dd4bf' },
      { id: 'done', type: 'textarea', label: '이번 주 완료', placeholder: '완료한 업무를 입력하세요', required: true },
      { id: 'plan', type: 'textarea', label: '다음 주 계획', placeholder: '다음 주 업무 계획', required: true }
    ],
    etc: [
      { id: 'done', type: 'textarea', label: '이번 주 완료', placeholder: '완료한 업무를 입력하세요', required: true },
      { id: 'plan', type: 'textarea', label: '다음 주 계획', placeholder: '다음 주 업무 계획', required: true }
    ]
  };
  
  Object.keys(defaults).forEach(r => {
    if (!tSettings.roles[r] || tSettings.roles[r].length === 0) {
      tSettings.roles[r] = JSON.parse(JSON.stringify(defaults[r]));
    }
  });
  
  renderTags('proj');
  renderTags('pRole');
  renderRolesEditor();
}

function renderTags(type) {
  const container = document.getElementById(type === 'proj' ? 'projTags' : 'pRoleTags');
  const items = type === 'proj' ? tSettings.projects : tSettings.projectRoles;
  container.innerHTML = items.map((item, idx) => `
    <div class="tag-chip">
      ${esc(item)}
      <span class="del" onclick="removeTag('${type}', ${idx})">&times;</span>
    </div>
  `).join('');
}

async function addTag(type) {
  const input = document.getElementById(type === 'proj' ? 'addProjInput' : 'addPRoleInput');
  const val = input.value.trim();
  if (!val) return;
  const items = type === 'proj' ? tSettings.projects : tSettings.projectRoles;
  if (items.includes(val)) { toast('이미 존재하는 항목입니다.', 'err'); return; }
  items.push(val);
  
  // 서버에 즉시 반영
  showActionLoader('항목 추가 중...');
  try {
    const key = type === 'proj' ? 'projects_schema' : 'project_roles_schema';
    await api(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ key, value: JSON.stringify(items) }),
    });
    // 전역 설정 갱신 및 UI 동기화
    globalSettings[key] = [...items];
    input.value = '';
    renderTags(type);
    updateMemberDropdowns();
    toast('✅ 추가되었습니다', 'ok');
  } catch (e) {
    toast('추가 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 실시간 동기화 함수
function updateMemberDropdowns() {
  // 팀원 관리 테이블 다시 그리기
  if (typeof renderRoleTable === 'function') renderRoleTable();
  // 팀원 추가 팝업의 프로젝트/역할 목록 갱신
  if (typeof updateAddMemberPRoles === 'function') updateAddMemberPRoles();
}

function removeTag(type, idx) {
  const items = type === 'proj' ? tSettings.projects : tSettings.projectRoles;
  items.splice(idx, 1);
  renderTags(type);
}

function renderRolesEditor() {
  const container = document.getElementById('rolesEditor');
  const roles = { dev: '👨‍💻 개발직군 (dev)', ops: '⚙️ 운영직군 (ops)', etc: '👤 기타직군 (etc)' };
  
  container.innerHTML = Object.entries(roles).map(([id, label]) => {
    const fields = tSettings.roles[id] || [];
    const color = id === 'dev' ? '#388bfd' : id === 'ops' ? '#3fb950' : '#d29922';
    return `
      <div class="field-group-card" style="border-left-color: ${color}">
        <div class="role-group-title" style="color: ${color}">${label}</div>
        <div id="fields_${id}" class="table-scroll" style="margin: 0 -12px; padding: 0 12px">
          <div style="min-width: 520px; display: flex; flex-direction: column; gap: 8px">
          ${fields.map((f, fidx) => `
            <div class="field-item">
              <div style="display:flex; flex-direction:column; gap:4px; flex:1">
                <span style="font-size:10px; font-weight:700; color:var(--text2)">필드명 / 안내문구</span>
                <div style="display:flex; gap:8px">
                  <input type="text" value="${esc(f.label)}" placeholder="예: 이번 주 완료" onchange="updateField('${id}', ${fidx}, 'label', this.value)" style="width:140px; font-weight:600">
                  <input type="text" value="${esc(f.placeholder||'')}" placeholder="안내 문구 입력 (선택)" onchange="updateField('${id}', ${fidx}, 'placeholder', this.value)" style="flex:1">
                </div>
              </div>
              <div style="display:flex; flex-direction:column; gap:4px;">
                <span style="font-size:10px; font-weight:700; color:var(--text2)">형식 / 필수</span>
                <div style="display:flex; gap:8px; align-items:center">
                  <select onchange="updateField('${id}', ${fidx}, 'type', this.value)" style="width:110px">
                    <option value="textarea" ${f.type==='textarea'?'selected':''}>📝 긴 글</option>
                    <option value="counter" ${f.type==='counter'?'selected':''}>🔢 수치</option>
                  </select>
                  <label style="font-size:12px; display:flex; align-items:center; gap:4px; cursor:pointer; user-select:none">
                    <input type="checkbox" ${f.required?'checked':''} onchange="updateField('${id}', ${fidx}, 'required', this.checked)"> 필수
                  </label>
                </div>
              </div>
              <button class="ico-btn" onclick="removeField('${id}', ${fidx})" style="border-radius:10px; color:var(--danger); border-color:rgba(248,81,73,0.2); margin-top:14px">✕</button>
            </div>
          `).join('')}
          </div>
        </div>
        <button class="btn btn-s btn-sm" onclick="addField('${id}')" style="margin-top:12px; width:100%; border-style: dashed; background: transparent">+ 새 필드 추가</button>
      </div>
    `;
  }).join('');
}

function addField(role) {
  if (!tSettings.roles[role]) tSettings.roles[role] = [];
  const newId = 'f_' + Math.random().toString(36).substr(2, 5);
  tSettings.roles[role].push({ id: newId, type: 'textarea', label: '', placeholder: '', required: false });
  renderRolesEditor();
}

function removeField(role, idx) {
  tSettings.roles[role].splice(idx, 1);
  renderRolesEditor();
}

function updateField(role, idx, key, val) {
  tSettings.roles[role][idx][key] = val;
}

async function saveGlobalSettings() {
  try {
    // 유효성 검사: 레이블이 비어있는 필드 확인
    for (const [role, fields] of Object.entries(tSettings.roles)) {
      if (fields.some(f => !f.label.trim())) {
        toast(`${role} 직군의 모든 필드명을 입력해주세요.`, 'err'); return;
      }
    }

    showActionLoader('양식 설정 저장 중...');
    await api('/api/settings/projects_schema', { method: 'PUT', body: JSON.stringify({ key: 'projects_schema', value: JSON.stringify(tSettings.projects) }) });
    await api('/api/settings/project_roles_schema', { method: 'PUT', body: JSON.stringify({ key: 'project_roles_schema', value: JSON.stringify(tSettings.projectRoles) }) });
    await api('/api/settings/roles_schema', { method: 'PUT', body: JSON.stringify({ key: 'roles_schema', value: JSON.stringify(tSettings.roles) }) });

    toast('✅ 설정이 저장되었습니다.', 'ok');
    await loadSettings();
  } catch(e) {
    toast('설정 저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

let _permsLoaded = false;   // 탭 토글마다 재조회 방지 — 부여/회수 시에만 force 재조회
async function loadPermissions(force = false) {
  if (!force && _permsLoaded) return;
  try {
    const perms = await api('/api/permissions');
    _permsLoaded = true;
    const tbody = document.querySelector('#permTable tbody');
    tbody.innerHTML = perms.map(p => {
      const sd = (p.starts_at || '').slice(0, 10);
      const ed = (p.expires_at || '').slice(0, 10);
      return `<tr>
      <td style="font-weight:600; white-space:nowrap">${p.member_name}</td>
      <td style="white-space:nowrap">${getWeekLabel(p.week_key)} <span style="color:var(--text3);font-size:12px">[${weekRange(p.week_key)}]</span></td>
      <td style="font-size:12px;color:var(--text2); white-space:nowrap">${sd} ~ ${ed}</td>
      <td style="text-align:right; white-space:nowrap">
        <button class="btn btn-d btn-sm" style="white-space:nowrap;min-width:44px" onclick="revokePermission('${p.member_name}', '${p.week_key}')">회수</button>
      </td>
    </tr>`;
    }).join('');
  } catch (e) {
    console.error('권한 목록 불러오기 실패:', e);
  }
}

async function revokePermission(name, wk) {
  if (!confirm(`${name}님의 ${getWeekLabel(wk)} 수정 권한을 회수하시겠습니까?`)) return;
  showActionLoader('권한 회수 중...');
  try {
    await api(`/api/permissions/${encodeURIComponent(name)}/${encodeURIComponent(wk)}`, { method: 'DELETE' });
    toast('권한이 회수되었습니다.', 'ok');
    loadPermissions(true);
  } catch (e) {
    toast('회수 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  마감 설정 (관리자)
// ═══════════════════════════════════════
let _dlConfig = null;

const DAY_NAMES = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];

let _dlLoaded = false;   // 탭 토글마다 재조회 방지 — 저장은 _dlConfig 를 그대로 유지하므로 재조회 불필요
async function loadDeadlineSettings() {
  if (_dlLoaded && _dlConfig) { renderDeadlineSettings(); return; }
  try {
    _dlConfig = await api('/api/settings/deadline/config');
    _dlLoaded = true;
  } catch {
    _dlConfig = { report_day: 4, deadline_day_offset: -1, deadline_time: '18:00', holidays: [], enabled: true };
  }
  renderDeadlineSettings();
}

function renderDeadlineSettings() {
  const el = document.getElementById('deadlineSettingsArea');
  if (!el || !_dlConfig) return;

  const holidayChips = (_dlConfig.holidays || []).sort().map((h, i) =>
    `<span class="tag-chip">${h}<span class="del" onclick="removeHoliday(${i})">&times;</span></span>`
  ).join('') || '<span style="color:var(--text3);font-size:12px">등록된 공휴일 없음</span>';

  el.innerHTML = `
    <div class="s-section" style="grid-column:1/-1">
      <div class="s-section-title">⏰ 마감 설정</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="dlEnabled" ${_dlConfig.enabled ? 'checked' : ''} onchange="updateDlField('enabled', this.checked)">
          마감 기능 활성화
        </label>
      </div>
      <!-- 3분할 grid: 데스크탑은 3열, 모바일은 auto-fit 으로 1~3열 자동 wrap. 라벨 한 줄 고정 + 박스 동일 높이 -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:12px;margin-bottom:18px;align-items:end">
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">보고일</div>
          <select id="dlReportDay" onchange="updateDlField('report_day', parseInt(this.value))"
            style="width:100%;height:38px;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:0 10px;border-radius:8px;font-size:13px">
            ${DAY_NAMES.map((d, i) => `<option value="${i}" ${_dlConfig.report_day === i ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">마감일 (보고일 기준)</div>
          <select id="dlOffset" onchange="updateDlField('deadline_day_offset', parseInt(this.value))"
            style="width:100%;height:38px;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:0 10px;border-radius:8px;font-size:13px">
            <option value="-2" ${_dlConfig.deadline_day_offset === -2 ? 'selected' : ''}>2일 전</option>
            <option value="-1" ${_dlConfig.deadline_day_offset === -1 ? 'selected' : ''}>1일 전 (전일)</option>
            <option value="0" ${_dlConfig.deadline_day_offset === 0 ? 'selected' : ''}>보고일 당일</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">마감 시각</div>
          <input type="time" id="dlTime" value="${_dlConfig.deadline_time}" onchange="updateDlField('deadline_time', this.value)"
            style="width:100%;height:38px;box-sizing:border-box;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:0 10px;border-radius:8px;font-size:13px">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">📅 공휴일 관리</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:8px">보고일이 공휴일이면 마감일이 자동으로 하루 앞당겨집니다.</div>
        <div class="tag-container" id="holidayTags">${holidayChips}</div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input type="date" id="addHolidayInput" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:8px;font-size:13px">
          <button class="btn btn-s btn-sm" onclick="addHoliday()">추가</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <button class="btn btn-p" onclick="saveDeadlineSettings()">마감 설정 저장</button>
      </div>
    </div>`;
}

function updateDlField(key, val) {
  if (_dlConfig) _dlConfig[key] = val;
}

function addHoliday() {
  const input = document.getElementById('addHolidayInput');
  const val = input.value;
  if (!val) return;
  if (!_dlConfig.holidays) _dlConfig.holidays = [];
  if (_dlConfig.holidays.includes(val)) { toast('이미 등록된 날짜입니다.', 'err'); return; }
  _dlConfig.holidays.push(val);
  input.value = '';
  renderDeadlineSettings();
}

function removeHoliday(idx) {
  _dlConfig.holidays.splice(idx, 1);
  renderDeadlineSettings();
}

async function saveDeadlineSettings() {
  showActionLoader('마감 설정 저장 중...');
  try {
    await api('/api/settings/deadline/config', {
      method: 'PUT',
      body: JSON.stringify({ key: 'deadline_config', value: JSON.stringify(_dlConfig) })
    });
    toast('✅ 마감 설정이 저장되었습니다.', 'ok');
  } catch (e) {
    toast('마감 설정 저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ── 푸시 알림 테스트 (관리자) ──
function populatePushTestSelect() {
  const sel = document.getElementById('pushTestTarget');
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  (members || []).forEach(m => {
    const o = document.createElement('option');
    o.value = m.name;
    o.textContent = m.name;
    sel.appendChild(o);
  });
}

async function sendTestPush() {
  const sel = document.getElementById('pushTestTarget');
  const target = sel ? sel.value : '__all__';
  const resultEl = document.getElementById('pushTestResult');
  if (resultEl) resultEl.textContent = '발송 중...';
  try {
    const res = await api('/api/push/test', {
      method: 'POST',
      body: JSON.stringify({ target })
    });
    // res = {sent, failed, cleaned, no_sub, total, errors: []}
    const lines = [];
    if (target === '__all__') {
      const parts = [`📊 ${res.total}명 대상`];
      parts.push(`✅ ${res.sent} 발송`);
      if (res.failed > 0)  parts.push(`❌ ${res.failed} 실패`);
      if (res.cleaned > 0) parts.push(`🧹 ${res.cleaned} 만료 정리`);
      if (res.no_sub > 0)  parts.push(`⚪ ${res.no_sub} 미구독`);
      lines.push(parts.join(' / '));
    } else {
      if (res.no_sub > 0)        lines.push(`⚪ ${target}님은 푸시 구독이 없습니다 (PWA 설치 + 알림 허용 필요)`);
      else if (res.sent > 0)     lines.push(`✅ ${target}님에게 발송 완료 (${res.sent}건)`);
      else if (res.cleaned > 0)  lines.push(`🧹 ${target}님의 만료된 구독 ${res.cleaned}건 자동 정리됨 — PWA 재설치 + 알림 허용 후 재시도`);
      else if (res.failed > 0)   lines.push(`❌ ${target}님 발송 실패 (${res.failed}건)`);
    }
    // 만료 정리 안내
    if (res.cleaned > 0 && target === '__all__') {
      lines.push('');
      lines.push(`💡 만료 정리: ${res.cleaned}개 구독이 OS/브라우저에서 unsubscribed/expired 상태였습니다.`);
      lines.push(`   해당 사용자는 PWA 를 삭제 후 재설치하여 알림 권한을 다시 허용해야 합니다.`);
    }
    if (res.errors && res.errors.length) {
      lines.push('');
      lines.push('— 실패 상세 —');
      res.errors.forEach(e => lines.push('  • ' + e));
    }
    const msg = lines.join('\n');
    if (resultEl) {
      resultEl.style.whiteSpace = 'pre-wrap';
      resultEl.textContent = msg;
    }
    // 토스트 요약
    const summary = res.sent > 0 && res.failed === 0
      ? `✅ ${res.sent}명에게 발송 완료`
      : res.failed > 0
        ? `❌ ${res.failed}건 실패 — 결과 영역에서 상세 확인`
        : res.cleaned > 0
          ? `🧹 ${res.cleaned}건 만료 정리 — PWA 재설치 필요`
          : res.no_sub > 0
            ? `⚪ 구독자 없음 — PWA 설치 + 알림 허용 필요`
            : '발송 완료';
    toast(summary, res.failed > 0 ? 'err' : (res.sent > 0 ? 'ok' : 'info'));
  } catch (e) {
    const err = `❌ 발송 실패: ${e.message}`;
    if (resultEl) resultEl.textContent = err;
    toast(err, 'err');
  }
}

// ── 마감 알림 즉시 발송 (관리자 수동 트리거) ──
async function sendDeadlinePushNow() {
  const resultEl = document.getElementById('deadlinePushResult');
  if (!confirm(`본인 ${orgLabel('team')}의 이번 주 미제출자에게 마감 알림을 지금 발송합니다.\n계속하시겠습니까?`)) return;
  if (resultEl) resultEl.textContent = '발송 중...';
  try {
    // 본인 팀 ID — landing-config 에서 현재 team slug 로 찾기, 또는 그냥 전체 발송 (서버가 슬러그로 분기)
    // 일반 관리자는 본인 팀 한정 발송이 자연스러움 — 서버에 body 없이 호출 → 전체 팀 (시스템관리자 케이스)
    // 본인 팀만 필요하면 X-Team-Slug 헤더로 자동 분기. 일단 body 없이 전체로 호출.
    const r = await api('/api/push/send-deadline-now', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    let lines = [];
    if (r.mode === 'single_team') {
      const x = r.result;
      lines.push(`📊 ${x.team_name} 결과:`);
      if (x.skipped_reason) lines.push(`  ⚠ 스킵: ${x.skipped_reason}`);
      else {
        lines.push(`  미제출: ${x.unsubmitted_count}명`);
        lines.push(`  ✅ 발송: ${x.sent} / ⚪ 미구독: ${x.no_sub} / ❌ 실패: ${x.failed}`);
      }
    } else if (r.mode === 'all_teams') {
      const s = r.summary;
      lines.push(`📊 ${s.teams_processed}개 ${orgLabel('team')} 처리 — ${s.teams_sent}개 ${orgLabel('team')} 발송 성공`);
      lines.push(`  ✅ 총 ${s.total_sent} / ⚪ 미구독 ${s.total_no_sub} / ❌ 실패 ${s.total_failed}`);
      lines.push('');
      lines.push(`— ${orgLabel('team')}별 상세 —`);
      (s.details || []).forEach(d => {
        if (d.error) {
          lines.push(`  ❌ ${d.team_name}: ${d.error}`);
        } else if (d.skipped_reason) {
          lines.push(`  ⏭ ${d.team_name}: ${d.skipped_reason}`);
        } else {
          lines.push(`  ${d.sent > 0 ? '✅' : '⚪'} ${d.team_name} — ${d.unsubmitted_count}명 대상 / ${d.sent} 발송`);
        }
      });
    }
    const msg = lines.join('\n');
    if (resultEl) resultEl.textContent = msg;
    toast(`✅ 마감 알림 발송 완료`, 'ok');
  } catch (e) {
    const err = `❌ 발송 실패: ${e.message}`;
    if (resultEl) resultEl.textContent = err;
    toast(err, 'err');
  }
}

// ── 푸시 진단 — 운영 트러블슈팅용 ──
async function loadPushDiagnostics() {
  const area = document.getElementById('pushDiagnosticsArea');
  if (!area) return;
  area.style.display = '';
  area.textContent = '진단 정보 불러오는 중...';
  try {
    const r = await api('/api/push/diagnostics');
    const lines = [
      `[환경]`,
      `  서버 env:    ${r.env || '?'}  ← 이 환경의 PWA 구독에만 발송`,
      ``,
      `[VAPID]`,
      `  public key:    ${r.vapid_public_key_set  ? '✅ 설정됨' : '❌ 없음'}`,
      `  private key:   ${r.vapid_private_key_set ? '✅ 설정됨' : '❌ 없음'}`,
      `  sub (FCM):     ${r.vapid_sub_fcm  || ('mailto:' + (r.vapid_email||''))}`,
      `  sub (Apple):   ${r.vapid_sub_apple || ('mailto:' + (r.vapid_email||''))}`,
      `   ↳ FCM(안드로이드) 은 mailto: 옛 형식, Apple 만 엄격 형식 분리 적용`,
      ``,
      `[Library]`,
      `  pywebpush:   ${r.pywebpush_installed ? '✅ 설치됨' : '❌ 미설치 — pip install pywebpush 필요'}`,
      ``,
      `[Subscriptions — 이 팀(id=${r.team_id}) 만]`,
      `  이 팀, 모든 환경(prod+dev):   ${r.team_total ?? '?'}`,
      `  이 팀, 이 환경(${r.env}) 만:     ${r.env_subscriptions ?? '?'}`,
      `  멤버별 (이 환경):`,
      ...r.members.map(m => `    ${m.subscription_count > 0 ? '✅' : '⚪'} ${m.name.padEnd(12)} ${m.subscription_count}건`),
      ``,
      `[전역 디버그 — 모든 팀 합산]`,
      `  DB 전체 구독 수: ${r.total_subscriptions_global}  (다른 팀 + 멤버 매칭 안 되는 orphan 포함)`,
      `   ↳ 이 팀 합산 < 전체 → orphan stale 구독 존재 (옛 멤버 / 다른 팀)`,
      ``,
      `[해석]`,
      `  - 운영 서버와 개발 서버는 각자 환경(env) 의 구독에만 발송 → 알림 분리됨`,
      `  - 본인 ⚪ 인데 다른 사람은 ✅ 이면 본인 PWA 설치/알림 허용 다시 시도`,
      `  - VAPID 키 ❌ 이면 서버 환경변수/settings 손상`,
    ];
    area.textContent = lines.join('\n');
  } catch (e) {
    area.textContent = '진단 실패: ' + e.message;
  }
}
