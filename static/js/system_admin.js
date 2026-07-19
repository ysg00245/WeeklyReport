// ═══════════════════════════════════════════════════
//  시스템 관리자 패널 (system_admin.js)
//  - 로그인: checkAdmin()에서 is_system_admin 분기
//  - 전사 현황 / 조직 관리 / 프롬프트 / 시스템 설정
// ═══════════════════════════════════════════════════

// ── 상태 ─────────────────────────────────────────
let saOrg = { divisions: [], teams: [] };
let saPromptsCache = null;   // GET /prompts 결과 캐싱 (global / defaults / team_additions)

// ── 진입점 ───────────────────────────────────────

/**
 * 시스템 관리자로 로그인 성공 시 호출.
 * 4개 탭 데이터를 모두 병렬로 prefetch 한 뒤 화면 노출 → 탭 전환 시 즉시 표시.
 */
async function gotoSysAdmin() {
  _saInitDone = false;
  showPage('pgSystemAdmin');
  saTab('stats', document.querySelector('#pgSystemAdmin .tab-new'), { skipLoad: true });
  showActionLoader('시스템 관리자 데이터 로드 중...');
  try {
    // 4탭 데이터 병렬 로드 — 탭 전환 시 다시 안 가져오게 캐싱
    await Promise.all([
      saLoadStats().catch(e => console.error('[SysAdmin] stats:', e)),
      saLoadOrg().catch(e => console.error('[SysAdmin] org:', e)),
      saLoadPrompts().catch(e => console.error('[SysAdmin] prompts:', e)),
      saLoadSystem().catch(e => console.error('[SysAdmin] system:', e)),
    ]);
  } catch (e) {
    console.error('[SysAdmin] 패널 로드 실패:', e);
    toast('시스템 관리자 패널 로드 실패: ' + e.message, 'err');
  } finally {
    _saInitDone = true;
    hideActionLoader();
  }
}

function doSysAdminLogout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('wr_sysadmin_token');
  localStorage.removeItem('wr_token');
  showPage('pgLogin');
}

// 외부에서 강제 새로고침이 필요할 때 사용 (저장/삭제 직후 등)
async function saRefreshAll() {
  saPromptsCache = null;
  await Promise.all([
    saLoadStats().catch(() => {}),
    saLoadOrg().catch(() => {}),
    saLoadPrompts().catch(() => {}),
    saLoadSystem().catch(() => {}),
  ]);
}

// ── 탭 전환 ──────────────────────────────────────
//  데이터는 gotoSysAdmin 에서 미리 prefetch 했으므로 탭 클릭 시 추가 호출 없음.
//  UI 표시 전환만 담당.

let _saInitDone = false;

function saTab(name, btn, opts) {
  opts = opts || {};
  ['stats', 'org', 'prompts', 'system'].forEach(t => {
    const el = document.getElementById(`saTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
    if (el) el.style.display = t === name ? '' : 'none';
  });
  document.querySelectorAll('#pgSystemAdmin .tab-new').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // 데이터 재로드 없음 — 명시적 새로고침이 필요하면 saRefreshAll() 호출
}

// ── 전사 현황 ─────────────────────────────────────

async function saLoadStats() {
  try {
    const data = await saApi('/api/system-admin/stats');
    if (!data) return;
    document.getElementById('saWeekLabel').textContent = data.week_key || '';

    // 상단 요약 카드
    const cards = document.getElementById('saStatsCards');
    cards.innerHTML = `
      <div class="stat-new">
        <div class="stat-ic">🏢</div>
        <div class="stat-label">전체 ${orgLabel('team')}</div>
        <div class="stat-value">${data.teams.length}</div>
      </div>
      <div class="stat-new">
        <div class="stat-ic">👥</div>
        <div class="stat-label">전체 ${orgLabel('member')}</div>
        <div class="stat-value">${data.total_members}</div>
      </div>
      <div class="stat-new">
        <div class="stat-ic success">✓</div>
        <div class="stat-label">전사 제출</div>
        <div class="stat-value">${data.total_submits}<span class="faint"> / ${data.total_members}</span></div>
        <div class="stat-progress" style="margin-top:10px"><span style="width:${data.total_rate}%"></span></div>
      </div>
      <div class="stat-new">
        <div class="stat-ic warning">📊</div>
        <div class="stat-label">전사 제출률</div>
        <div class="stat-value">${data.total_rate}%</div>
      </div>
    `;

    // 팀별 목록 — 본부 단위 그룹 패널 (응답에 division_id 가 없으면 내부에서 /org 보완)
    const list = document.getElementById('saTeamStatsList');
    list.innerHTML = await _renderStatsByDivision(data);
    // 본부 헤더 클릭 → 접기/펼치기
    list.querySelectorAll('.sa-divgrp-head').forEach(h => {
      h.addEventListener('click', () => {
        const grp = h.closest('.sa-divgrp');
        grp.classList.toggle('collapsed');
      });
    });
  } catch (e) {
    toast('현황 로드 실패: ' + e.message, 'err');
  }
}

// 전사현황 — 본부별 묶음 패널 렌더 헬퍼
async function _renderStatsByDivision(data) {
  const teams = (data.teams || []).slice();
  let divisions = (data.divisions && data.divisions.length) ? data.divisions : null;

  // stats 응답에 division_id 가 누락된 경우 (서버가 구버전 코드일 때) → /org 강제 로드 후 매핑
  const needFallback = teams.some(t => t.division_id == null);
  if (needFallback || !divisions) {
    // saOrg 비어있으면 강제로 로드
    if (!window.saOrg || !saOrg.teams || !saOrg.teams.length) {
      try { saOrg = await saApi('/api/system-admin/org'); } catch (_) {}
    }
    if (window.saOrg && saOrg.teams && saOrg.teams.length) {
      const orgMap = new Map(saOrg.teams.map(t => [t.id, t]));
      teams.forEach(t => {
        if (t.division_id == null) {
          const ot = orgMap.get(t.id);
          if (ot && ot.division_id != null) t.division_id = ot.division_id;
        }
      });
      if (!divisions) divisions = saOrg.divisions || [];
    }
  }
  divisions = divisions || [];

  // division_id → 팀 배열
  const byDiv = new Map();
  teams.forEach(t => {
    const key = (t.division_id == null) ? 0 : t.division_id;
    if (!byDiv.has(key)) byDiv.set(key, []);
    byDiv.get(key).push(t);
  });

  // 본부 순서 + 미지정(0) 맨 뒤
  const ordered = [];
  divisions.forEach(d => {
    if (byDiv.has(d.id)) ordered.push({ id: d.id, name: d.name, teams: byDiv.get(d.id) });
  });
  if (byDiv.has(0)) ordered.push({ id: 0, name: orgLabel('division') + ' 미지정', teams: byDiv.get(0) });

  if (!ordered.length) {
    return `<div style="padding:20px;text-align:center;color:var(--text2)">${olj('team','이')} 없습니다</div>`;
  }

  const teamRow = (t) => {
    const color = t.submit_rate >= 80 ? 'var(--success)' : t.submit_rate >= 50 ? 'var(--warning)' : 'var(--danger)';
    return `
      <div style="display:flex;align-items:center;padding:9px 14px;border-top:1px solid var(--border);gap:12px">
        <div style="flex:1;font-size:13px;font-weight:600;color:var(--text)">${esc(t.team_name)}</div>
        <div style="font-size:12px;color:var(--text2)">${t.member_count}명</div>
        <div style="width:110px"><div class="stat-progress"><span style="width:${t.submit_rate}%"></span></div></div>
        <div style="font-size:12px;font-weight:700;min-width:70px;text-align:right;color:${color}">
          ${t.submit_count}/${t.member_count} (${t.submit_rate}%)
        </div>
      </div>`;
  };

  return ordered.map(grp => {
    const memberTotal = grp.teams.reduce((a, t) => a + (t.member_count || 0), 0);
    const submitTotal = grp.teams.reduce((a, t) => a + (t.submit_count || 0), 0);
    const rate = memberTotal ? Math.round(submitTotal / memberTotal * 1000) / 10 : 0;
    const color = rate >= 80 ? 'var(--success)' : rate >= 50 ? 'var(--warning)' : 'var(--danger)';
    return `
      <div class="sa-divgrp" style="border:1px solid var(--border);border-radius:10px;margin:10px 0;overflow:hidden;background:var(--bg)">
        <div class="sa-divgrp-head" style="display:flex;align-items:center;padding:10px 14px;gap:12px;cursor:pointer;background:var(--bg2);user-select:none">
          <span class="sa-divgrp-caret" style="display:inline-block;transition:transform .2s;font-size:11px;color:var(--text2)">▼</span>
          <div style="flex:1;font-size:14px;font-weight:700;color:var(--text)">🏢 ${esc(grp.name)}</div>
          <div style="font-size:12px;color:var(--text2)">${orgLabel('team')} ${grp.teams.length} · ${memberTotal}명</div>
          <div style="width:110px"><div class="stat-progress"><span style="width:${rate}%"></span></div></div>
          <div style="font-size:13px;font-weight:700;min-width:70px;text-align:right;color:${color}">${submitTotal}/${memberTotal} (${rate}%)</div>
        </div>
        <div class="sa-divgrp-body">
          ${grp.teams.map(teamRow).join('')}
        </div>
      </div>`;
  }).join('');
}

// ── 조직 관리 ─────────────────────────────────────

async function saLoadOrg() {
  try {
    saOrg = await saApi('/api/system-admin/org');
    renderSaDivisions();
    renderSaTeams();
  } catch (e) {
    toast('조직 로드 실패: ' + e.message, 'err');
  }
}

// 본부 클릭 필터 상태 (-1 = 전체, 0 = 미지정, N = division_id)
let _saDivFilter = -1;

// 그룹장 컨테이너(divhq-*) 판별 — 별도 유닛이 아니라 '그룹 자체'를 가리키는 내부 row.
// 유닛 목록/유닛 수에서 제외하고, 그룹장 카드로만 구분 표시한다.
function _saIsHqTeam(t) { return (t && t.slug || '').startsWith('divhq-'); }

function renderSaDivisions() {
  const el = document.getElementById('saDivisionList');
  if (!saOrg.divisions.length) {
    el.innerHTML = `<div style="padding:16px;color:var(--text2);font-size:13px;text-align:center">등록된 ${olj('division','가')} 없습니다</div>`;
    return;
  }
  // 본부 카드 (클릭 → 해당 팀 하이라이트/필터). "전체" 칩이 첫 줄에 위치
  const chipAll = `
    <div class="sa-div-row${_saDivFilter === -1 ? ' active' : ''}" data-div-id="-1" style="display:flex;align-items:center;padding:9px 14px;border-bottom:1px dashed var(--border);gap:10px;cursor:pointer;font-weight:600">
      <div style="flex:1;font-size:13px;color:var(--text)">전체 보기</div>
      <span style="font-size:11px;color:var(--text2)">${saOrg.teams.filter(t => !_saIsHqTeam(t)).length}${orgLabel('team')}</span>
    </div>`;
  const rows = saOrg.divisions.map(d => {
    const cnt = saOrg.teams.filter(t => t.division_id === d.id && !_saIsHqTeam(t)).length;
    return `
      <div class="sa-div-row${_saDivFilter === d.id ? ' active' : ''}" data-div-id="${d.id}" style="display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);gap:10px;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(d.name)} <span style="font-size:11px;color:var(--text2);font-weight:400">· ${cnt}${orgLabel('team')}</span></div>
          <div style="font-size:11px;color:var(--text2)">${d.head_name ? orgLabel('division_head') + ': ' + esc(d.head_name) : orgLabel('division_head') + ' 미지정'}</div>
        </div>
        <button class="btn-new sm ghost" onclick='event.stopPropagation();openSaDivisionForm(${JSON.stringify(d)})'>편집</button>
        <button class="btn-new sm ghost" style="color:var(--danger)" onclick="event.stopPropagation();deleteSaDivision('${esc(d.slug)}','${esc(d.name)}')">삭제</button>
      </div>`;
  });
  // "본부 미지정" 칩 (해당 팀 존재 시만)
  const unassignedCnt = saOrg.teams.filter(t => !t.division_id).length;
  const chipUnassigned = unassignedCnt > 0 ? `
    <div class="sa-div-row${_saDivFilter === 0 ? ' active' : ''}" data-div-id="0" style="display:flex;align-items:center;padding:9px 14px;border-top:1px dashed var(--border);gap:10px;cursor:pointer;color:var(--text2)">
      <div style="flex:1;font-size:13px">📂 ${orgLabel('division')} 미지정</div>
      <span style="font-size:11px">${unassignedCnt}${orgLabel('team')}</span>
    </div>` : '';

  el.innerHTML = chipAll + rows.join('') + chipUnassigned;

  // 클릭 이벤트 바인딩
  el.querySelectorAll('.sa-div-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.divId, 10);
      _saDivFilter = (_saDivFilter === id) ? -1 : id;
      renderSaDivisions();
      renderSaTeams({ highlightDiv: _saDivFilter });
    });
  });
}

function renderSaTeams(opts = {}) {
  const el = document.getElementById('saTeamList');
  if (!saOrg.teams.length) {
    el.innerHTML = `<div style="padding:16px;color:var(--text2);font-size:13px;text-align:center">등록된 ${olj('team','이')} 없습니다</div>`;
    return;
  }
  const divMap = Object.fromEntries(saOrg.divisions.map(d => [d.id, d.name]));
  const filter = (opts.highlightDiv != null) ? opts.highlightDiv : _saDivFilter;

  // 본부 헤더로 묶어서 렌더 (saOrg.teams 는 이미 본부 순으로 정렬됨)
  const groups = new Map();
  saOrg.teams.forEach(t => {
    const k = t.division_id || 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });

  const ordered = [];
  saOrg.divisions.forEach(d => {
    if (groups.has(d.id)) ordered.push({ id: d.id, name: d.name, teams: groups.get(d.id) });
  });
  if (groups.has(0)) ordered.push({ id: 0, name: orgLabel('division') + ' 미지정', teams: groups.get(0) });

  // 필터 적용 (-1 = 전체)
  const visible = (filter === -1) ? ordered : ordered.filter(g => g.id === filter);

  el.innerHTML = visible.map(grp => {
    const teamCards = grp.teams.map(t => {
      const isHq = _saIsHqTeam(t);
      const divHead = (saOrg.divisions.find(d => d.id === t.division_id) || {}).head_name || '';
      const leader = isHq
        ? `👑 ${orgLabel('division_head')}: ${esc(divHead)}`
        : (t.leader_name ? `${orgLabel('leader')}: ${esc(t.leader_name)}` : `${orgLabel('leader')} 미지정`);
      const ras = [t.report_admin_primary, t.report_admin_secondary].filter(Boolean).map(esc).join(', ');
      const rasLabel = ras ? ` · 주보관리: ${ras}` : '';
      const hasReportAdmin = !!(t.report_admin_primary || t.report_admin_secondary);
      const notifyBtn = hasReportAdmin
        ? `<button class="btn-new sm ghost" title="주간보고 관리자에게 안내 푸시 재발송" onclick='notifyTeamAdminPw(${JSON.stringify(t.slug)},${JSON.stringify(t.name)})'>🔔 재발송</button>`
        : '';
      const membersBtn = (t.member_count ?? 0) > 0
        ? `<button class="btn-new sm ghost" title="${orgLabel('member')} 노출 토글 / PIN 초기화" onclick='openSaTeamMembers(${JSON.stringify(t.slug)},${JSON.stringify(t.name)})'>👥 멤버</button>`
        : '';
      return `
        <div class="sa-team-card" data-div-id="${t.division_id || 0}" data-team-slug="${esc(t.slug)}"
             style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;row-gap:8px;padding:10px 14px;border-top:1px solid var(--border);transition:background .15s,box-shadow .25s">
          <div style="flex:1 1 240px;min-width:120px;word-break:keep-all">
            <div style="font-size:14px;font-weight:600;color:var(--text);word-break:keep-all">${isHq ? `👑 ${esc(t.name)} 직속` : esc(t.name)}</div>
            <div style="font-size:11px;color:var(--text2);word-break:keep-all">${isHq ? `${orgLabel('division')} 직속 소속 · ${t.member_count ?? 0}명` : `${esc(t.slug)} · ${t.member_count ?? 0}명 · ${esc(divMap[t.division_id] || (orgLabel('division') + ' 미지정'))}`}</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px;word-break:keep-all">${leader}${rasLabel}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
            ${membersBtn}
            ${isHq ? '' : notifyBtn}
            ${isHq
              ? `<button class="btn-new sm ghost" title="${orgLabel('division')} 직속 구성원 추가 (유닛 미소속 인원)" onclick='openSaAddMemberToTeam(${JSON.stringify(t.slug)},${JSON.stringify(t.name)})'>➕ 직속 구성원</button>
                 <span style="font-size:11px;color:var(--text3);align-self:center">${orgLabel('division_head')}·명칭은 ${orgLabel('division')} 편집에서</span>`
              : `<button class="btn-new sm ghost" onclick='openSaTeamForm(${JSON.stringify(t)})'>편집</button>
                 <button class="btn-new sm ghost" style="color:var(--danger)" onclick="deleteSaTeam('${esc(t.slug)}','${esc(t.name)}')">삭제</button>`}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="sa-team-grp" data-div-id="${grp.id}" style="border-bottom:1px solid var(--border)">
        <div style="padding:8px 14px;background:var(--bg2);font-size:12px;font-weight:700;color:var(--text2);letter-spacing:.4px;text-transform:none">
          🏢 ${esc(grp.name)} <span style="color:var(--text2);font-weight:400">· ${grp.teams.filter(t => !_saIsHqTeam(t)).length}${orgLabel('team')}</span>
        </div>
        ${teamCards}
      </div>`;
  }).join('');

  // 필터링이 곧 강조이므로 별도 펄스 애니메이션은 불필요
}

// ── 시스템 관리자 — 팀원 관리 모달 (v3.1.0) ─────────────
let _saMembersTeamSlug = null;
let _saMembersCache = [];
let _saMembersTeamMeta = null;   // { leader_name, report_admin_primary, report_admin_secondary }

// 직급(position) 옵션 — 직장 계급만. 유닛장/그룹장/이사 등은 '직책'(title) 으로 별도 분리.
// const → let : 시스템관리자 콘솔에서 settings(position_options/title_options)로 오버라이드 가능.
// 아래 배열은 settings 가 비어있을 때의 기본값. 항상 맨 앞에 ''(선택 안 함) 포함.
let _SA_POSITION_OPTIONS = ['', '사원', '주임', '대리', '과장', '차장', '부장'];
// 직책 기본값의 '팀장'·'본부장' 은 ORG_LABELS 기본값과 일치하는 초기 fallback.
// 조직 호칭을 바꾼 회사(그룹/유닛 등)에서는 _saDefaultTitleOptions() 가 설정 적용 시점에 덮어쓴다
// (모듈 로드 시점엔 서버 호칭이 아직 안 와서 여기서 orgLabel() 을 부르면 항상 기본값이 박힌다).
let _SA_TITLE_OPTIONS = ['', '팀장', '이사', '본부장', '연구소장'];
function _saDefaultTitleOptions() {
  return ['', orgLabel('leader'), '이사', orgLabel('division_head'), '연구소장'];
}

// ── 직급·직책 옵션 관리 (편집 중 작업 리스트 — '' 제외) ──
let _jobPosList = [], _jobTitleList = [];
function _renderJobEditors() {
  _jobPosList   = _SA_POSITION_OPTIONS.filter(Boolean);
  _jobTitleList = _SA_TITLE_OPTIONS.filter(Boolean);
  _drawJobChips();
}
function _drawJobChips() {
  const draw = (elId, list, kind) => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = list.length ? list.map((v, i) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 6px 4px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:999px;font-size:12px;margin:0 6px 6px 0">${esc(v)}<button onclick="removeJobOpt('${kind}',${i})" title="삭제" style="border:none;background:none;color:var(--text3);cursor:pointer;font-size:12px;line-height:1;padding:0">✕</button></span>`
    ).join('') : '<span class="faint" style="font-size:12px">항목 없음</span>';
  };
  draw('saPosChips',   _jobPosList,   'pos');
  draw('saTitleChips', _jobTitleList, 'title');
}
function addJobOpt(kind) {
  const inp = document.getElementById(kind === 'pos' ? 'saPosInput' : 'saTitleInput');
  const v = (inp.value || '').trim();
  if (!v) return;
  const list = kind === 'pos' ? _jobPosList : _jobTitleList;
  if (list.includes(v)) { toast('이미 있는 항목입니다', 'err'); return; }
  list.push(v); inp.value = ''; _drawJobChips();
}
function removeJobOpt(kind, i) {
  (kind === 'pos' ? _jobPosList : _jobTitleList).splice(i, 1);
  _drawJobChips();
}
async function saveJobOpts() {
  showActionLoader('직급/직책 옵션 저장 중...');
  try {
    await _saPutSetting('position_options', _jobPosList);
    await _saPutSetting('title_options',    _jobTitleList);
    _SA_POSITION_OPTIONS = ['', ..._jobPosList];
    _SA_TITLE_OPTIONS    = ['', ..._jobTitleList];
    toast('✅ 직급/직책 옵션이 저장되었습니다', 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 직급/직책/프로젝트 select 옵션 채우기
function _saFillMemberOptionSelects() {
  // 프로젝트 옵션: 현재 팀에서 사용 중인 project 합집합 + '기타' + 빈값
  const usedProjs = Array.from(new Set(
    (_saMembersCache || []).map(m => (m.project || '').trim()).filter(Boolean)
  )).sort();
  const ordered = usedProjs.filter(p => p !== '기타').concat(['기타']);
  const projOpts = ['', ...ordered];

  const renderOpts = (opts, selected) => opts.map(v =>
    `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v) || '(선택 안 함)'}</option>`
  ).join('');

  // 추가 행 — 기본 선택 없음. 직책은 추가 시점엔 없음 (편집에서만)
  const addPos = document.getElementById('saMemberAddPosition');
  const addProj = document.getElementById('saMemberAddProject');
  if (addPos)  addPos.innerHTML  = renderOpts(_SA_POSITION_OPTIONS, '');
  if (addProj) addProj.innerHTML = renderOpts(projOpts, '');

  // 편집 모달 — 현재 멤버의 값을 selected 로 (saOpenMemberEdit 에서 dataset.pendingValue 설정 후 호출)
  const editPos = document.getElementById('saMemberEditPosition');
  const editTitle = document.getElementById('saMemberEditTitle');
  const editProj = document.getElementById('saMemberEditProject');
  if (editPos) {
    const curPos = editPos.dataset.pendingValue || '';
    // 옛 데이터에서 임원/팀장이 position 에 저장돼 있을 수도 — 옵션 자동 보강
    const fullPosOpts = _SA_POSITION_OPTIONS.includes(curPos) ? _SA_POSITION_OPTIONS : [..._SA_POSITION_OPTIONS, curPos];
    editPos.innerHTML = renderOpts(fullPosOpts, curPos);
  }
  if (editTitle) {
    const curTitle = editTitle.dataset.pendingValue || '';
    const fullTitleOpts = _SA_TITLE_OPTIONS.includes(curTitle) ? _SA_TITLE_OPTIONS : [..._SA_TITLE_OPTIONS, curTitle];
    editTitle.innerHTML = renderOpts(fullTitleOpts, curTitle);
  }
  if (editProj) {
    const curProj = editProj.dataset.pendingValue || '';
    const fullProjOpts = projOpts.includes(curProj) ? projOpts : [...projOpts, curProj];
    editProj.innerHTML = renderOpts(fullProjOpts, curProj);
  }
}

async function openSaTeamMembers(slug, teamName) {
  _saMembersTeamSlug = slug;
  document.getElementById('saMembersModalTitle').textContent = `${orgLabel('member')} 관리 — ${teamName}`;
  // 추가 행 비우기
  const addNameEl = document.getElementById('saMemberAddName');
  if (addNameEl) addNameEl.value = '';
  // position/project 는 select 라 value 초기화는 fillOptions 가 해줌
  // 로딩 스피너 (텍스트 + 회전 아이콘)
  const listEl = document.getElementById('saMembersList');
  if (listEl) listEl.innerHTML = `
    <div style="padding:40px 20px;text-align:center;color:var(--text2)">
      <div style="display:inline-block;width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--brand-500);border-radius:50%;animation:sa-rotate .8s linear infinite"></div>
      <div style="margin-top:12px;font-size:13px">${orgLabel('member')} 정보를 불러오는 중...</div>
    </div>`;
  openModal('saMembersModal');
  try {
    const r = await saApi(`/api/system-admin/teams/${encodeURIComponent(slug)}/members`);
    _saMembersCache = r.members || [];
    _saMembersTeamMeta = r.team || null;
    _saFillMemberOptionSelects(); // 직급/프로젝트 select 옵션 채우기
    _saRenderMembersList();
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--danger)">불러오기 실패: ${esc(e.message)}</div>`;
  }
}

async function saAddMember() {
  if (!_saMembersTeamSlug) return;
  const name     = (document.getElementById('saMemberAddName')?.value || '').trim();
  const position = (document.getElementById('saMemberAddPosition')?.value || '').trim();
  const project  = (document.getElementById('saMemberAddProject')?.value || '').trim();
  if (!name) return toast('이름을 입력해주세요', 'err');
  showActionLoader(`${orgLabel('member')} 추가 중...`);
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members`, {
      method: 'POST',
      body: JSON.stringify({ name, role: 'etc', position, project, sub_role: '' }),
    });
    toast(`✓ ${name} 추가됨`, 'ok');
    document.getElementById('saMemberAddName').value = '';
    // select 들은 첫 옵션('')으로 초기화
    const addPos = document.getElementById('saMemberAddPosition');
    const addProj = document.getElementById('saMemberAddProject');
    if (addPos)  addPos.value = '';
    if (addProj) addProj.value = '';
    // 다시 불러오기
    const r = await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members`);
    _saMembersCache = r.members || [];
    _saFillMemberOptionSelects(); // 새 프로젝트가 추가됐을 수 있음 — 옵션 재계산
    _saRenderMembersList();
    // 조직 캐시도 갱신 (멤버 수 변동)
    saLoadOrg().catch(() => {});
  } catch (e) {
    toast('추가 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function saOpenMemberEdit(name) {
  const m = _saMembersCache.find(x => x.name === name);
  if (!m) return;
  document.getElementById('saMemberEditOrigName').value = m.name;
  document.getElementById('saMemberEditName').value     = m.name;
  // select 의 selected 옵션을 동적 렌더링하기 위해 dataset 에 보관 후 fill 호출
  const editPos = document.getElementById('saMemberEditPosition');
  const editTitle = document.getElementById('saMemberEditTitle');
  const editProj = document.getElementById('saMemberEditProject');
  if (editPos)   editPos.dataset.pendingValue   = m.position || '';
  if (editTitle) editTitle.dataset.pendingValue = m.title    || '';
  if (editProj)  editProj.dataset.pendingValue  = m.project  || '';
  _saFillMemberOptionSelects();
  document.getElementById('saMemberEditSubRole').value  = m.sub_role || '';
  document.getElementById('saMemberEditRole').value     = m.role || 'etc';
  openModal('saMemberEditModal');
}

async function saSubmitMemberEdit() {
  if (!_saMembersTeamSlug) return;
  const orig = document.getElementById('saMemberEditOrigName').value;
  const titleEl = document.getElementById('saMemberEditTitle');
  const payload = {
    new_name: document.getElementById('saMemberEditName').value.trim(),
    position: document.getElementById('saMemberEditPosition').value.trim(),
    title:    titleEl ? titleEl.value.trim() : '',
    project:  document.getElementById('saMemberEditProject').value.trim(),
    sub_role: document.getElementById('saMemberEditSubRole').value.trim(),
    role:     document.getElementById('saMemberEditRole').value,
  };
  if (!payload.new_name) return toast('이름은 비울 수 없습니다', 'err');
  showActionLoader(`${orgLabel('member')} 정보 저장 중...`);
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members/${encodeURIComponent(orig)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    closeModal('saMemberEditModal');
    toast(`✓ ${orgLabel('member')} 정보가 저장되었습니다`, 'ok');
    // 새로고침
    const r = await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members`);
    _saMembersCache = r.members || [];
    _saRenderMembersList();
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saDeleteMember(name) {
  if (!_saMembersTeamSlug) return;
  if (!confirm(`"${name}" 님을 ${orgLabel('team')}에서 삭제하시겠습니까?\n현재 주차 보고서와 PIN 정보가 함께 삭제됩니다. 과거 이력은 보존됩니다.`)) return;
  showActionLoader(`${orgLabel('member')} 삭제 중...`);
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    toast(`✓ ${name} 삭제 완료`, 'ok');
    _saMembersCache = _saMembersCache.filter(x => x.name !== name);
    _saRenderMembersList();
    saLoadOrg().catch(() => {});
  } catch (e) {
    toast('삭제 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function _saRenderMembersList() {
  const listEl = document.getElementById('saMembersList');
  if (!listEl) return;
  if (!_saMembersCache.length) {
    listEl.innerHTML = `<div class="faint" style="padding:20px;text-align:center">등록된 ${olj('member','이')} 없습니다</div>`;
    return;
  }
  const meta = _saMembersTeamMeta || {};
  listEl.innerHTML = _saMembersCache.map(m => {
    const visible = m.is_visible !== false;
    const pinBadge = m.has_pin
      ? '<span style="font-size:11px;color:var(--success);background:color-mix(in oklab, var(--success) 12%, transparent);padding:2px 8px;border-radius:999px">PIN 등록됨</span>'
      : '<span style="font-size:11px;color:var(--text2);background:var(--bg2);padding:2px 8px;border-radius:999px">PIN 미등록</span>';
    const projBadge = m.project ? `<span style="font-size:11px;color:var(--text2);background:var(--bg2);padding:2px 8px;border-radius:999px">${esc(m.project)}</span>` : '';
    // 직책(직급과 별개): 팀장 / 주보관리자(정·부) 배지
    const roleBadges = [];
    if (m.name === meta.leader_name) {
      roleBadges.push(`<span style="font-size:11px;color:#fff;background:linear-gradient(135deg,var(--brand-500),var(--brand-700));padding:2px 8px;border-radius:999px;font-weight:700">👑 ${orgLabel('leader')}</span>`);
    }
    if (m.name === meta.report_admin_primary) {
      roleBadges.push('<span style="font-size:11px;color:var(--warning);background:color-mix(in oklab, var(--warning) 14%, transparent);padding:2px 8px;border-radius:999px;font-weight:600">📋 주보(정)</span>');
    }
    if (m.name === meta.report_admin_secondary) {
      roleBadges.push('<span style="font-size:11px;color:var(--warning);background:color-mix(in oklab, var(--warning) 8%, transparent);padding:2px 8px;border-radius:999px">📋 주보(부)</span>');
    }
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span>${esc(m.name)} <span class="faint" style="font-weight:400;font-size:12px">${esc(m.position || '')}</span></span>
            ${roleBadges.join(' ')}
          </div>
          <div style="margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${pinBadge} ${projBadge}</div>
        </div>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:${visible ? 'var(--bg2)' : 'color-mix(in oklab, var(--danger) 8%, transparent)'}">
          <input type="checkbox" ${visible ? 'checked' : ''} onchange="saToggleMemberVisibility('${esc(m.name)}', this.checked)" style="margin:0">
          <span>노출</span>
        </label>
        <button class="btn-new sm ghost" onclick="saOpenMemberEdit('${esc(m.name)}')" title="정보 수정">✏️</button>
        <button class="btn-new sm ghost" onclick="saResetMemberPin('${esc(m.name)}')" title="PIN 초기화" ${m.has_pin ? '' : 'disabled style="opacity:0.4"'}>🔑</button>
        <button class="btn-new sm ghost" onclick="saDeleteMember('${esc(m.name)}')" title="삭제" style="color:var(--danger)">🗑️</button>
      </div>`;
  }).join('');
}

// 그룹 직속 구성원 추가 — 유닛에 속하지 않고 그룹에 바로 소속되는 인원(대기 인원 등).
// divhq-* 컨테이너에 멤버를 넣는 것이며, 이후 관리는 일반 유닛과 동일하게 [👥 멤버] 모달에서.
async function openSaAddMemberToTeam(slug, teamName) {
  const name = (prompt(`"${teamName}" 직속으로 추가할 구성원 이름을 입력하세요.\n(유닛에 속하지 않고 ${orgLabel('division')}에 바로 소속되는 인원)\n\n※ 이미 등록된 구성원을 옮기려면 [전사 구성원 관리]의 인사이동/겸직을 사용하세요.`) || '').trim();
  if (!name) return;
  // 이미 다른 조직에 있는 이름이면 신규 생성 대신 인사이동을 안내 (중복 인원 생성 방지)
  try {
    const res = await saApi('/api/system-admin/members');
    const dup = (res.members || []).filter(m => m.name === name);
    if (dup.length) {
      const where = dup.map(d => d.team_name).join(', ');
      if (!confirm(`"${name}" 은(는) 이미 ${where} 에 등록돼 있습니다.\n그래도 새로 등록하면 동명이인으로 취급됩니다.\n\n(같은 사람이라면 [전사 구성원 관리] → 인사이동/겸직을 권장)\n\n계속 새로 등록할까요?`)) return;
    }
  } catch (_) {}
  const position = (prompt(`${name} 님의 직급을 입력하세요. (선택 — 비워도 됩니다)`) || '').trim();
  showActionLoader('직속 구성원 추가 중...');
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(slug)}/members`, {
      method: 'POST',
      body: JSON.stringify({ name, role: 'etc', position, title: '', project: '', sub_role: '' }),
    });
    toast(`✅ ${name} 님이 ${teamName} 직속으로 추가되었습니다`, 'ok');
    await saLoadOrg();
  } catch (e) {
    toast('추가 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saToggleMemberVisibility(name, isVisible) {
  if (!_saMembersTeamSlug) return;
  showActionLoader('노출 상태 변경 중...');
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members/${encodeURIComponent(name)}/visibility`, {
      method: 'PUT',
      body: JSON.stringify({ is_visible: !!isVisible }),
    });
    // 캐시 갱신
    const m = _saMembersCache.find(x => x.name === name);
    if (m) m.is_visible = !!isVisible;
    toast(`${name}: ${isVisible ? '노출' : '숨김'}`, 'ok');
    _saRenderMembersList();
  } catch (e) {
    toast('변경 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saResetMemberPin(name) {
  if (!_saMembersTeamSlug) return;
  if (!confirm(`"${name}" 님의 PIN 을 초기화하시겠습니까?\n다음 로그인 시 새 PIN 을 등록하게 됩니다.`)) return;
  showActionLoader('PIN 초기화 중...');
  try {
    await saApi(`/api/system-admin/teams/${encodeURIComponent(_saMembersTeamSlug)}/members/${encodeURIComponent(name)}/pin`, {
      method: 'DELETE',
    });
    const m = _saMembersCache.find(x => x.name === name);
    if (m) { m.has_pin = false; m.pin_set_at = null; }
    toast('PIN 초기화 완료', 'ok');
    _saRenderMembersList();
  } catch (e) {
    toast('PIN 초기화 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}


// ── 시스템 관리자 — 배너 콘텐츠 / 재노출 (v3.1.0) ─────────
async function saLoadBanner() {
  try {
    const r = await saApi('/api/system-admin/banner');
    const ov = r.override || {};
    const enabledEl = document.getElementById('saBannerEnabled');
    const formEl    = document.getElementById('saBannerForm');
    const statusEl  = document.getElementById('saBannerStatus');
    if (enabledEl) enabledEl.checked = !!ov.enabled;
    if (formEl)    formEl.style.display = ov.enabled ? 'flex' : 'none';

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    set('saBannerVersion',  ov.version);
    set('saBannerAudience', ov.audience || 'all');
    set('saBannerTitle',    ov.title);
    set('saBannerSub',      ov.sub);
    set('saBannerCtaText',  ov.cta_text);
    set('saBannerCtaAction', ov.cta_action || '');

    if (statusEl) statusEl.textContent = r.nonce ? `현재 nonce: ${r.nonce}` : '재노출 nonce 미설정 (기본 1회 노출만 적용 중)';

    // enabled 토글 → 폼 노출
    if (enabledEl && !enabledEl.dataset.bound) {
      enabledEl.addEventListener('change', () => {
        if (formEl) formEl.style.display = enabledEl.checked ? 'flex' : 'none';
      });
      enabledEl.dataset.bound = '1';
    }

    // 코드 기본 안내 목록(APP_VER_NOTES) → select 채움
    _saFillBannerDefaultsSelect();
  } catch (e) {
    console.warn('[SysAdmin] banner load 실패:', e?.message || e);
  }
}

function _saFillBannerDefaultsSelect() {
  const sel = document.getElementById('saBannerLoadDefault');
  if (!sel) return;
  if (!window.APP_VER_NOTES) {
    sel.innerHTML = '<option value="">(코드 기본 안내 목록을 찾을 수 없음)</option>';
    return;
  }
  const curVer = window.APP_VER || '';
  // 버전 키를 semver 역순으로 정렬 (최신 위)
  const keys = Object.keys(window.APP_VER_NOTES).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  sel.innerHTML = '<option value="">선택...</option>' + keys.map(k => {
    const note = window.APP_VER_NOTES[k] || {};
    const isCur = (k === curVer) ? ' (현재)' : '';
    const audLabel = ({ admin: '관리자', system_admin: '시스템관리자', member: '일반 ' + orgLabel('member'), all: '전체' })[note.audience] || (note.audience || 'all');
    const titleTxt = (note.title || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim().slice(0, 40);
    return `<option value="${esc(k)}">v${esc(k)}${isCur} · ${esc(audLabel)} · ${esc(titleTxt)}</option>`;
  }).join('');
}

function saBannerLoadDefault() {
  const sel = document.getElementById('saBannerLoadDefault');
  const ver = sel?.value;
  if (!ver) return toast('불러올 버전을 선택해주세요', 'err');
  const note = window.APP_VER_NOTES?.[ver];
  if (!note) return toast('해당 버전 안내를 찾을 수 없습니다', 'err');

  // 편집 ON + 폼 표시
  const enabledEl = document.getElementById('saBannerEnabled');
  if (enabledEl) enabledEl.checked = true;
  const formEl = document.getElementById('saBannerForm');
  if (formEl) formEl.style.display = 'flex';

  // 폼 자동 채움 (사용자가 그대로 저장하거나 수정 가능)
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('saBannerVersion',   ver);
  set('saBannerAudience',  note.audience || 'all');
  set('saBannerTitle',     note.title || '');
  set('saBannerSub',       note.sub || '');
  set('saBannerCtaText',   note.cta?.text || '');
  set('saBannerCtaAction', note.cta?.action || '');
  toast(`v${ver} 기본 안내를 폼에 채웠습니다. 저장 또는 강제 재노출 하세요.`, 'ok');
}

async function saBannerSave() {
  const enabled = document.getElementById('saBannerEnabled')?.checked || false;
  const payload = {
    enabled,
    version:    document.getElementById('saBannerVersion')?.value.trim()  || '',
    audience:   document.getElementById('saBannerAudience')?.value || 'all',
    title:      document.getElementById('saBannerTitle')?.value.trim()    || '',
    sub:        document.getElementById('saBannerSub')?.value.trim()      || '',
    cta_text:   document.getElementById('saBannerCtaText')?.value.trim()  || '',
    cta_action: document.getElementById('saBannerCtaAction')?.value       || '',
  };
  if (enabled && !payload.title && !payload.sub) {
    return toast('편집 ON 일 때는 제목 또는 부제를 입력해주세요', 'err');
  }
  showActionLoader('배너 콘텐츠 저장 중...');
  try {
    await saApi('/api/system-admin/banner', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    toast('✓ 배너 콘텐츠 저장 완료', 'ok');
    saLoadBanner();
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saBannerRepublish() {
  if (!confirm('이미 배너를 닫은 사용자에게도 한 번 더 표시합니다.\n계속하시겠습니까?')) return;
  showActionLoader('재노출 트리거 중...');
  try {
    const r = await saApi('/api/system-admin/banner/republish', { method: 'POST' });
    toast(`✓ 강제 재노출 적용 완료 (nonce: ${r.nonce?.slice(0, 6)}…)`, 'ok');
    saLoadBanner();
  } catch (e) {
    toast('재노출 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}


// 주간보고 관리자 안내 재발송
async function notifyTeamAdminPw(slug, teamName) {
  if (!confirm(`"${teamName}" ${orgLabel('team')}의 주간보고 관리자에게 비밀번호 안내 푸시를 재발송합니다.\n계속하시겠습니까?`)) return;
  showActionLoader('안내 푸시 발송 중...');
  try {
    const r = await saApi(`/api/system-admin/teams/${slug}/notify-admin-pw`, { method: 'POST' });
    const msg =
      `발송 ${r.sent}건 · 미구독 ${r.no_subscription}건\n` +
      (r.pending_alive ? `(다음 로그인 시 안내 모달 자동 표시 ${r.pending_alive}건)\n` : '') +
      (r.pending_gone ? `(비밀번호 슬롯 만료 ${r.pending_gone}건 — 비밀번호 재설정 필요)\n` : '');
    toast(msg.trim(), r.sent ? 'ok' : 'err');
  } catch (e) {
    toast('재발송 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 본부 폼
// 전사 구성원 이름을 datalist 에 채워 그룹장 입력을 '조회 기반'으로 만든다 (31차).
// 캐시(_mmAll)가 있으면 재사용하고, 없으면 1회 조회.
async function _saFillMemberNameList() {
  const dl = document.getElementById('saMemberNameList');
  if (!dl) return;
  try {
    if (!Array.isArray(_mmAll) || !_mmAll.length) {
      const res = await saApi('/api/system-admin/members');
      _mmAll = res.members || [];
    }
    const seen = new Set();
    dl.innerHTML = _mmAll
      .filter(m => m.is_active !== false && !seen.has(m.name) && seen.add(m.name))
      .map(m => `<option value="${esc(m.name)}">${esc(m.position || '')}${m.team_name ? ' · ' + esc(m.team_name) : ''}</option>`)
      .join('');
  } catch (_) { /* 자동완성 실패는 무시 — 수동 입력은 그대로 가능 */ }
}

function openSaDivisionForm(arg) {
  // arg 가 object 면 신구조, string 이면 (slug, name) — 후방호환
  const d = (typeof arg === 'object' && arg !== null) ? arg : { slug: arg || '', name: arguments[1] || '' };
  const isEdit = !!d.slug;
  document.getElementById('saDivisionModalTitle').textContent = isEdit ? `${orgLabel('division')} 편집` : `${orgLabel('division')} 추가`;
  document.getElementById('saDivisionEditSlug').value = d.slug || '';
  document.getElementById('saDivisionSlug').value = d.slug || '';
  document.getElementById('saDivisionSlug').disabled = isEdit;
  document.getElementById('saDivisionName').value = d.name || '';
  const headEl = document.getElementById('saDivisionHead');
  if (headEl) headEl.value = d.head_name || '';
  document.getElementById('saDivisionPw').value = '';
  _saFillMemberNameList();   // 전사 구성원 자동완성 (오타로 인한 조직 매칭 실패 방지)
  openModal('saDivisionModal');
}

async function submitSaDivision() {
  const editSlug = document.getElementById('saDivisionEditSlug').value;
  const slug = document.getElementById('saDivisionSlug').value.trim();
  const name = document.getElementById('saDivisionName').value.trim();
  const head = (document.getElementById('saDivisionHead')?.value || '').trim();
  const pw   = document.getElementById('saDivisionPw').value;
  if (!name) return toast(`${orgLabel('division')}명을 입력해주세요`, 'err');

  showActionLoader(editSlug ? `${orgLabel('division')} 정보 저장 중...` : `${orgLabel('division')} 추가 중...`);
  try {
    if (editSlug) {
      await saApi(`/api/divisions/${editSlug}`, { method: 'PUT', body: JSON.stringify({ name, head_name: head, admin_pw: pw }) });
    } else {
      if (!slug) return toast('슬러그를 입력해주세요', 'err');
      await saApi('/api/divisions', { method: 'POST', body: JSON.stringify({ slug, name, head_name: head, admin_pw: pw }) });
    }
    closeModal('saDivisionModal');
    toast(`✓ ${orgLabel('division')} 저장 완료`, 'ok');
    await saLoadOrg();
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function deleteSaDivision(slug, name) {
  if (!confirm(`"${name}" ${olj('division','를')} 삭제하시겠습니까?\n소속 ${olj('team','이')} 없을 때만 삭제됩니다.`)) return;
  showActionLoader(`${orgLabel('division')} 삭제 중...`);
  try {
    await saApi(`/api/divisions/${slug}`, { method: 'DELETE' });
    toast(`✓ ${olj('division','가')} 삭제되었습니다`, 'ok');
    await saLoadOrg();
  } catch (e) {
    toast('삭제 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 팀 폼
async function openSaTeamForm(arg) {
  // arg 가 object 면 신구조, 이전 (slug, name, divisionId) 호출도 후방호환
  const t = (typeof arg === 'object' && arg !== null)
    ? arg
    : { slug: arg || '', name: arguments[1] || '', division_id: arguments[2] };
  const isEdit = !!t.slug;
  document.getElementById('saTeamModalTitle').textContent = isEdit ? `${orgLabel('team')} 편집` : `${orgLabel('team')} 추가`;
  document.getElementById('saTeamEditSlug').value = t.slug || '';
  document.getElementById('saTeamSlug').value = t.slug || '';
  document.getElementById('saTeamSlug').disabled = isEdit;
  document.getElementById('saTeamName').value = t.name || '';
  document.getElementById('saTeamPw').value = '';

  // 본부 선택 드롭다운
  const divSel = document.getElementById('saTeamDivision');
  divSel.innerHTML = '<option value="">미지정</option>' +
    saOrg.divisions.map(d =>
      `<option value="${d.id}" ${d.id == t.division_id ? 'selected' : ''}>${esc(d.name)}</option>`
    ).join('');

  // 팀장/주보 콤보박스는 fetch 가 필요해 잠시 placeholder — 모달은 즉시 노출 (체감 1초 지연 제거)
  ['saTeamLeader', 'saTeamReportAdmin1', 'saTeamReportAdmin2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">불러오는 중...</option>';
  });
  openModal('saTeamModal');

  // 백그라운드로 멤버 fetch + 콤보박스 채움
  _saFillTeamPersonSelects(t).catch(() => {});
}

async function _saFillTeamPersonSelects(t) {
  const leaderSel = document.getElementById('saTeamLeader');
  const ra1Sel    = document.getElementById('saTeamReportAdmin1');
  const ra2Sel    = document.getElementById('saTeamReportAdmin2');
  const hint      = document.getElementById('saTeamLeaderHint');

  let members = [];
  let endpointError = false;
  if (t.slug) {
    try {
      const r = await saApi(`/api/system-admin/teams/${encodeURIComponent(t.slug)}/members`);
      members = r.members || [];
    } catch (e) {
      console.warn('[SysAdmin] /teams/{slug}/members 호출 실패:', e?.message || e);
      endpointError = true;
    }
  }

  // 신규 추가(아직 slug 없음) 또는 팀원 0명일 때 — 빈 옵션 + 안내
  const hasMembers = members.length > 0;
  if (hint) {
    if (endpointError) {
      hint.textContent = `${orgLabel('member')} 목록을 불러오지 못했습니다. (로컬 서버 재시작 필요 가능성)`;
      hint.style.display = '';
    } else if (t.slug && !hasMembers) {
      hint.textContent = `${olj('member','이')} 없습니다. ${orgLabel('team')} 저장 후 ${olj('member','을')} 먼저 등록해주세요.`;
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
  }

  const buildOptions = (current, allowEmpty, emptyLabel) => {
    const optEmpty = allowEmpty ? `<option value="">${esc(emptyLabel || '미지정')}</option>` : '';
    const optMembers = members.map(m => {
      const label = m.position ? `${m.name} (${m.position})` : m.name;
      const sel = (current && current === m.name) ? ' selected' : '';
      return `<option value="${esc(m.name)}"${sel}>${esc(label)}</option>`;
    }).join('');
    // 기존 값이 현재 팀원 목록에 없는 경우(과거 데이터 / 팀 이동 등) → 그대로 보존하기 위해 옵션 추가
    let optStale = '';
    if (current && !members.some(m => m.name === current)) {
      optStale = `<option value="${esc(current)}" selected>${esc(current)} (현재 ${orgLabel('team')}에 없음)</option>`;
    }
    return optEmpty + optStale + optMembers;
  };

  if (leaderSel) leaderSel.innerHTML = buildOptions(t.leader_name || '', true, '미지정');
  if (ra1Sel)    ra1Sel.innerHTML    = buildOptions(t.report_admin_primary || '', true, '미지정');
  if (ra2Sel)    ra2Sel.innerHTML    = buildOptions(t.report_admin_secondary || '', true, '미지정(1명만 운영)');
}

async function submitSaTeam() {
  const editSlug  = document.getElementById('saTeamEditSlug').value;
  const slug      = document.getElementById('saTeamSlug').value.trim();
  const name      = document.getElementById('saTeamName').value.trim();
  const divisionId = document.getElementById('saTeamDivision').value || null;
  const leader    = document.getElementById('saTeamLeader').value.trim();
  const ra1       = document.getElementById('saTeamReportAdmin1').value.trim();
  const ra2       = document.getElementById('saTeamReportAdmin2').value.trim();
  const pw        = document.getElementById('saTeamPw').value;
  if (!name) return toast(`${orgLabel('team')}명을 입력해주세요`, 'err');

  const payloadCommon = {
    name,
    division_id: divisionId ? parseInt(divisionId) : null,
    admin_pw: pw,
    leader_name: leader,
    report_admin_primary: ra1,
    report_admin_secondary: ra2,
  };

  showActionLoader(editSlug ? `${orgLabel('team')} 정보 저장 중...` : `${orgLabel('team')} 추가 중...`);
  try {
    if (editSlug) {
      await saApi(`/api/system-admin/teams/${editSlug}`, {
        method: 'PUT',
        body: JSON.stringify(payloadCommon),
      });
    } else {
      if (!slug) return toast('슬러그를 입력해주세요', 'err');
      await saApi('/api/system-admin/teams', {
        method: 'POST',
        body: JSON.stringify({ slug, ...payloadCommon }),
      });
    }
    closeModal('saTeamModal');
    toast(`✓ ${orgLabel('team')} 저장 완료`, 'ok');
    await saLoadOrg();
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function deleteSaTeam(slug, name) {
  if (!confirm(`"${name}" ${olj('team','을')} 삭제하시겠습니까?`)) return;
  showActionLoader(`${orgLabel('team')} 삭제 중...`);
  try {
    await saApi(`/api/system-admin/teams/${slug}`, { method: 'DELETE' });
    toast(`✓ ${olj('team','이')} 삭제되었습니다`, 'ok');
    await saLoadOrg();
  } catch (e) {
    toast('삭제 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ── 프롬프트 관리 ─────────────────────────────────
//  ai.py 가 사용하는 키 7종(페르소나 / 도우미 / 요약 5종)을 모두 보여준다.
//  - 사용자가 settings 에 값을 저장 안 했으면 ai.py 의 DEFAULT_* 값을 그대로 표시 (편집 시작점)
//  - "기본값으로" 버튼 → settings row 삭제 (DELETE /prompts/global/{key}) → 기본값으로 리셋

const _SA_PROMPT_KEYS = [
  'ai_persona',
  'ai_assist_prompt',
  'ai_format_member_individual',
  'ai_format_member_group',
  'ai_format_project',
  'ai_format_team',
];

// 멤버 요약 카드의 active 모드 — admin 화면과 동일한 버튼 토글 방식
let _saMemberPromptMode = 'individual';  // 'individual' | 'group'

function _saMemberPromptKey() {
  return _saMemberPromptMode === 'individual'
    ? 'ai_format_member_individual'
    : 'ai_format_member_group';
}

function saSwitchMemberMode(mode) {
  if (mode !== 'individual' && mode !== 'group') return;
  // 현재 입력 중인 textarea 내용을 캐시로 보존 (저장 안 했어도 모드 전환 시 안 잃도록)
  const cur = document.getElementById('saMemberPromptTxt');
  if (cur && saPromptsCache) {
    saPromptsCache.global = saPromptsCache.global || {};
    saPromptsCache.global[_saMemberPromptKey()] = cur.value;
  }
  _saMemberPromptMode = mode;

  // 버튼 inline 스타일 토글 (admin 페이지의 setMemberPromptMode 패턴과 동일)
  const indBtn = document.getElementById('saMemberPromptIndBtn');
  const grpBtn = document.getElementById('saMemberPromptGrpBtn');
  if (indBtn && grpBtn) {
    if (mode === 'individual') {
      indBtn.style.background = 'var(--accent)';
      indBtn.style.color = '#fff';
      grpBtn.style.background = 'var(--bg2)';
      grpBtn.style.color = 'var(--text2)';
    } else {
      grpBtn.style.background = 'var(--accent)';
      grpBtn.style.color = '#fff';
      indBtn.style.background = 'var(--bg2)';
      indBtn.style.color = 'var(--text2)';
    }
  }

  // 새 textarea 값
  if (cur && saPromptsCache) {
    const key = _saMemberPromptKey();
    const g = saPromptsCache.global || {};
    const d = saPromptsCache.defaults || {};
    cur.value = (key in g) ? g[key] : (d[key] || '');
    cur.dataset.user = (key in g) ? '1' : '0';
  }
}

async function saveSaMemberPrompt() {
  const key = _saMemberPromptKey();
  const ta = document.getElementById('saMemberPromptTxt');
  if (!ta) return;
  showActionLoader('프롬프트 저장 중...');
  try {
    await saApi(`/api/system-admin/prompts/global/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ content: ta.value }),
    });
    if (saPromptsCache) {
      saPromptsCache.global = saPromptsCache.global || {};
      saPromptsCache.global[key] = ta.value;
    }
    ta.dataset.user = '1';
    toast('✓ 프롬프트 저장 완료', 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function resetSaMemberPrompt() {
  const key = _saMemberPromptKey();
  if (!confirm(`현재 모드(${_saMemberPromptMode === 'individual' ? '개별' : '그룹'}) 프롬프트를 시스템 기본값으로 되돌립니다.\n계속하시겠습니까?`)) return;
  showActionLoader('기본값 복원 중...');
  try {
    await saApi(`/api/system-admin/prompts/global/${key}`, { method: 'DELETE' });
    if (saPromptsCache && saPromptsCache.global) delete saPromptsCache.global[key];
    const ta = document.getElementById('saMemberPromptTxt');
    if (ta && saPromptsCache && saPromptsCache.defaults) {
      ta.value = saPromptsCache.defaults[key] || '';
      ta.dataset.user = '0';
    }
    toast('기본값으로 복원되었습니다');
  } catch (e) {
    toast('복원 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function _saFillPromptTextareas(data) {
  // settings 에 저장된 값이 있으면 그걸, 없으면 default 를 textarea 에 채움
  const globals  = (data && data.global)   || {};
  const defaults = (data && data.defaults) || {};
  // 단일 textarea 카드들 (persona, assist, project, team)
  _SA_PROMPT_KEYS.forEach(key => {
    const ta = document.getElementById(`saPrompt_${key}`);
    if (!ta) return;
    const val = (key in globals) ? globals[key] : (defaults[key] || '');
    ta.value = val;
    ta.dataset.user = (key in globals) ? '1' : '0';
  });
  // 멤버 통합 카드 — 현재 active 모드의 값 표시
  const memberTa = document.getElementById('saMemberPromptTxt');
  if (memberTa) {
    const key = _saMemberPromptKey();
    memberTa.value = (key in globals) ? globals[key] : (defaults[key] || '');
    memberTa.dataset.user = (key in globals) ? '1' : '0';
  }
}

async function saLoadPrompts() {
  try {
    const data = await saApi('/api/system-admin/prompts');
    saPromptsCache = data;
    _saFillPromptTextareas(data);

    // 팀별 추가 프롬프트
    const list = document.getElementById('saTeamPromptList');
    if (!data.team_additions || !data.team_additions.length) {
      list.innerHTML = `<div style="padding:12px 0;color:var(--text2);font-size:13px">${orgLabel('team')}별 추가 프롬프트 없음</div>`;
      return;
    }
    list.innerHTML = data.team_additions.map(ta => `
      <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text)">${esc(ta.team_name)}</div>
        ${Object.entries(ta.additions).map(([key, val]) => `
          <div style="margin-bottom:10px">
            <label class="label-new" style="font-size:11px">${esc(key)}</label>
            <textarea class="input-new" rows="4" id="saTeamPrompt_${ta.team_id}_${key}"
              style="font-family:monospace;font-size:12px;resize:vertical;margin-top:4px">${esc(val)}</textarea>
            <div style="display:flex;gap:6px;margin-top:4px">
              <button class="btn-new sm" onclick="saveSaTeamPrompt(${ta.team_id},'${key}')">저장</button>
              <button class="btn-new sm ghost" style="color:var(--danger)" onclick="deleteSaTeamPrompt(${ta.team_id},'${key}')">삭제</button>
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch (e) {
    toast('프롬프트 로드 실패: ' + e.message, 'err');
  }
}

async function saveSaGlobalPrompt(key) {
  const ta = document.getElementById(`saPrompt_${key}`);
  if (!ta) return toast('프롬프트 요소를 찾을 수 없습니다', 'err');
  const content = ta.value;
  showActionLoader('프롬프트 저장 중...');
  try {
    await saApi(`/api/system-admin/prompts/global/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    if (saPromptsCache) {
      saPromptsCache.global = saPromptsCache.global || {};
      saPromptsCache.global[key] = content;
    }
    ta.dataset.user = '1';
    toast('✓ 프롬프트 저장 완료', 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function resetSaGlobalPrompt(key) {
  if (!confirm('이 프롬프트를 시스템 기본값으로 되돌립니다.\n사용자가 저장한 오버라이드는 삭제됩니다.\n계속하시겠습니까?')) return;
  showActionLoader('기본값 복원 중...');
  try {
    await saApi(`/api/system-admin/prompts/global/${key}`, { method: 'DELETE' });
    // 캐시에서 사용자 오버라이드 제거 후 textarea 를 default 로 다시 채움
    if (saPromptsCache && saPromptsCache.global) delete saPromptsCache.global[key];
    const ta = document.getElementById(`saPrompt_${key}`);
    if (ta && saPromptsCache && saPromptsCache.defaults) {
      ta.value = saPromptsCache.defaults[key] || '';
      ta.dataset.user = '0';
    }
    toast('기본값으로 복원되었습니다');
  } catch (e) {
    toast('복원 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saveSaTeamPrompt(teamId, key) {
  const el = document.getElementById(`saTeamPrompt_${teamId}_${key}`);
  if (!el) return;
  showActionLoader(`${orgLabel('team')} 프롬프트 저장 중...`);
  try {
    await saApi(`/api/system-admin/prompts/team/${teamId}/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ content: el.value }),
    });
    toast(`✓ ${orgLabel('team')} 프롬프트 저장 완료`, 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function deleteSaTeamPrompt(teamId, key) {
  if (!confirm(`이 ${orgLabel('team')} 추가 프롬프트를 삭제하시겠습니까?`)) return;
  showActionLoader('프롬프트 삭제 중...');
  try {
    await saApi(`/api/system-admin/prompts/team/${teamId}/${key}`, { method: 'DELETE' });
    toast('삭제 완료');
    await saLoadPrompts();
  } catch (e) {
    toast('삭제 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ── 시스템 설정 ───────────────────────────────────

// 멀티팀 설정 카드: 마지막 로드된 서버 상태 (되돌리기 / dirty 비교용)
let _saMtSnapshot = null;

async function saLoadSystem() {
  // 1) 전역 settings 로드 (team_id=0) → 토글 + 기본팀 slug + 표시 항목 화이트리스트
  let cfg = {};
  try {
    cfg = await saApi('/api/system-admin/settings') || {};
  } catch (e) { /* 설정 없을 수 있음 */ }

  // 기본팀 + 표시 항목 채우기 위해 조직(본부/팀) 목록 필요 — saOrg 캐시 우선, 없으면 API
  let org = saOrg;
  if (!org || !org.teams || org.teams.length === 0) {
    try { org = await saApi('/api/system-admin/org'); } catch (_) { org = { divisions: [], teams: [] }; }
  }

  // 스냅샷 저장 (되돌리기·dirty 판정 기준)
  // pwa_install_enabled default true — undefined/null 일 때 true 로 처리
  const pwaInstallVal = cfg['pwa_install_enabled'];
  _saMtSnapshot = {
    multi_team_enabled: (cfg['multi_team_enabled'] === true || cfg['multi_team_enabled'] === 'true'),
    default_team_slug:  cfg['default_team_slug'] || 'default',
    visible_division_ids: Array.isArray(cfg['visible_division_ids']) ? cfg['visible_division_ids'].map(Number) : [],
    visible_team_ids:     Array.isArray(cfg['visible_team_ids'])     ? cfg['visible_team_ids'].map(Number)     : [],
    pwa_install_enabled: (pwaInstallVal === undefined || pwaInstallVal === null) ? true
                          : (pwaInstallVal === true || pwaInstallVal === 'true'),
  };

  _saApplyMultiTeamSnapshot(_saMtSnapshot, org);

  // 직급/직책 옵션 — settings 오버라이드 반영 후 관리 카드 렌더
  if (Array.isArray(cfg['position_options'])) _SA_POSITION_OPTIONS = ['', ...cfg['position_options'].filter(Boolean)];
  if (Array.isArray(cfg['title_options']))    _SA_TITLE_OPTIONS    = ['', ...cfg['title_options'].filter(Boolean)];
  else                                        _SA_TITLE_OPTIONS    = _saDefaultTitleOptions();   // 설정 미지정 시 조직 호칭 반영
  _renderJobEditors();
  // 조직 호칭 — cfg 값으로 ORG_LABELS 갱신 + 편집기 채움
  if (cfg['org_labels'] && typeof setOrgLabels === 'function') setOrgLabels(cfg['org_labels']);
  loadOrgLabelEditor();

  // 배너 콘텐츠 / nonce 카드 로드 (병렬은 saRefreshAll 단에서 처리되지만 직접 호출도 보완)
  saLoadBanner().catch(() => {});

  // 개발 환경 여부 → 개발 전용 카드 표시 + 동기화 테이블 체크박스 채움
  try {
    const env = await saApi('/api/system-admin/env-info');
    const card = document.getElementById('saDevSyncCard');
    if (card) card.style.display = env.is_dev ? '' : 'none';

    // 시드 카드 환경 안내
    const envNote = document.getElementById('saSeedEnvNote');
    if (envNote) {
      envNote.textContent = env.is_dev
        ? '현재 개발 환경 — 즉시 실행됩니다.'
        : '현재 운영 환경 — 추가 확인 토큰 입력이 필요합니다.';
    }

    // 동기화 테이블 체크박스 (dev 환경에서만 의미 있음)
    if (env.is_dev) {
      const listEl = document.getElementById('saSyncTableList');
      if (listEl && !listEl.dataset.loaded) {
        try {
          const r = await saApi('/api/system-admin/sync-tables');
          const tables = r.tables || [];
          // 기본 선택: members, reports 만 (가장 흔한 use case)
          const defaultChecked = new Set(['members', 'reports']);
          listEl.innerHTML = tables.map(t => `
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg2)">
              <input type="checkbox" class="sa-sync-tbl" value="${esc(t)}" ${defaultChecked.has(t) ? 'checked' : ''}>
              <span>${esc(t)}</span>
            </label>
          `).join('');
          listEl.dataset.loaded = '1';
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// 스냅샷 값을 UI 에 반영 (최초 로드 + 되돌리기 양쪽에서 사용)
function _saApplyMultiTeamSnapshot(snap, org) {
  // 멀티팀 토글
  const toggle = document.getElementById('saMultiTeamToggle');
  if (toggle) toggle.checked = !!snap.multi_team_enabled;

  // 기본팀 드롭다운 — 단순히 팀명만 표시
  const sel = document.getElementById('saDefaultTeamSelect');
  if (sel) {
    sel.innerHTML = (org.teams || []).map(t =>
      `<option value="${esc(t.slug)}" ${t.slug === snap.default_team_slug ? 'selected' : ''}>${esc(t.name)}</option>`
    ).join('');
  }

  // 표시 항목 체크박스 (본부)
  const divs = document.getElementById('saVisibleDivisions');
  if (divs) {
    const visIds = new Set((snap.visible_division_ids || []).map(Number));
    const list = (org.divisions || []);
    if (!list.length) {
      divs.innerHTML = `<div class="faint" style="font-size:12px;padding:6px 4px">등록된 ${olj('division','가')} 없습니다</div>`;
    } else {
      divs.innerHTML = list.map(d => `
        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" class="sa-vis-div" value="${d.id}" ${visIds.has(d.id) ? 'checked' : ''}>
          <span>${esc(d.name)}</span>
        </label>
      `).join('');
    }
  }

  // 표시 항목 체크박스 (팀)
  const teamsBox = document.getElementById('saVisibleTeams');
  if (teamsBox) {
    const visIds = new Set((snap.visible_team_ids || []).map(Number));
    const list = (org.teams || []);
    if (!list.length) {
      teamsBox.innerHTML = `<div class="faint" style="font-size:12px;padding:6px 4px">등록된 ${olj('team','이')} 없습니다</div>`;
    } else {
      teamsBox.innerHTML = list.map(t => `
        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
          <input type="checkbox" class="sa-vis-team" value="${t.id}" ${visIds.has(t.id) ? 'checked' : ''}>
          <span>${esc(t.name)} <span class="faint" style="font-size:11px">(${esc(t.slug)})</span></span>
        </label>
      `).join('');
    }
  }

  // dirty 상태 초기화
  _saMtUpdateDirty();

  // PWA 설치 토글 — 스냅샷 값 반영
  const pwaTog = document.getElementById('saPwaInstallToggle');
  if (pwaTog) pwaTog.checked = (snap.pwa_install_enabled !== false);

  // 모든 입력 변경에 dirty 갱신 바인딩 (innerHTML 재구성 후마다 다시 연결)
  const root = document.getElementById('saTabSystem');
  if (root) {
    root.querySelectorAll('#saMultiTeamToggle, #saDefaultTeamSelect, .sa-vis-div, .sa-vis-team, #saPwaInstallToggle')
      .forEach(el => {
        el.removeEventListener('change', _saMtUpdateDirty);
        el.addEventListener('change', _saMtUpdateDirty);
      });
  }
}

// 현재 UI 상태를 객체로 추출
function _saReadMultiTeamUI() {
  const toggle = document.getElementById('saMultiTeamToggle');
  const sel    = document.getElementById('saDefaultTeamSelect');
  const pwaToggle = document.getElementById('saPwaInstallToggle');
  const divIds  = Array.from(document.querySelectorAll('.sa-vis-div:checked')).map(el => parseInt(el.value, 10));
  const teamIds = Array.from(document.querySelectorAll('.sa-vis-team:checked')).map(el => parseInt(el.value, 10));
  return {
    multi_team_enabled: !!(toggle && toggle.checked),
    default_team_slug:  (sel && sel.value) || 'default',
    visible_division_ids: divIds.sort((a, b) => a - b),
    visible_team_ids:     teamIds.sort((a, b) => a - b),
    pwa_install_enabled: pwaToggle ? !!pwaToggle.checked : true,
  };
}

// dirty 비교: 현재 UI vs 마지막 스냅샷
function _saMtIsDirty() {
  if (!_saMtSnapshot) return false;
  const cur = _saReadMultiTeamUI();
  const snap = _saMtSnapshot;
  if (cur.multi_team_enabled !== !!snap.multi_team_enabled) return true;
  if (cur.default_team_slug !== snap.default_team_slug) return true;
  const sortedSnap = (snap.visible_division_ids || []).slice().sort((a, b) => a - b);
  const sortedSnapT = (snap.visible_team_ids || []).slice().sort((a, b) => a - b);
  if (JSON.stringify(cur.visible_division_ids) !== JSON.stringify(sortedSnap)) return true;
  if (JSON.stringify(cur.visible_team_ids)     !== JSON.stringify(sortedSnapT)) return true;
  if (cur.pwa_install_enabled !== !!snap.pwa_install_enabled) return true;
  return false;
}

// dirty 상태에 따라 푸터 라벨/버튼 강조 갱신
function _saMtUpdateDirty() {
  const dirty = _saMtIsDirty();
  const mark = document.getElementById('saMtDirtyMark');
  const save = document.getElementById('saMtSave');
  const reset = document.getElementById('saMtReset');
  if (mark) {
    if (dirty) {
      mark.textContent = '● 저장되지 않은 변경사항이 있습니다';
      mark.style.color = 'var(--warning, #d97706)';
      mark.style.fontWeight = '600';
    } else {
      mark.textContent = '저장된 상태와 동일';
      mark.style.color = '';
      mark.style.fontWeight = '';
    }
  }
  if (save)  save.disabled = !dirty;
  if (reset) reset.disabled = !dirty;
}

// 되돌리기 — 스냅샷 상태로 UI 복원
function saMultiTeamReset() {
  if (!_saMtSnapshot) return;
  if (!_saMtIsDirty()) return;
  if (!confirm('변경사항을 되돌릴까요?')) return;
  saLoadSystem();
}

// 일괄 저장 — 4개 키 한 번에 PUT
async function saMultiTeamSave() {
  const btn = document.getElementById('saMtSave');
  if (!btn) return;
  const cur = _saReadMultiTeamUI();
  const snap = _saMtSnapshot || {};

  // 비교 후 변경된 키만 전송 (네트워크 절약)
  const tasks = [];
  if (cur.multi_team_enabled !== !!snap.multi_team_enabled) {
    tasks.push(_saPutSetting('multi_team_enabled', cur.multi_team_enabled));
  }
  if (cur.default_team_slug !== snap.default_team_slug) {
    tasks.push(_saPutSetting('default_team_slug', cur.default_team_slug));
  }
  const sortedSnapD = (snap.visible_division_ids || []).slice().sort((a, b) => a - b);
  const sortedSnapT = (snap.visible_team_ids     || []).slice().sort((a, b) => a - b);
  if (JSON.stringify(cur.visible_division_ids) !== JSON.stringify(sortedSnapD)) {
    tasks.push(_saPutSetting('visible_division_ids', cur.visible_division_ids));
  }
  if (JSON.stringify(cur.visible_team_ids) !== JSON.stringify(sortedSnapT)) {
    tasks.push(_saPutSetting('visible_team_ids', cur.visible_team_ids));
  }
  if (cur.pwa_install_enabled !== !!snap.pwa_install_enabled) {
    tasks.push(_saPutSetting('pwa_install_enabled', cur.pwa_install_enabled));
  }

  if (!tasks.length) { toast('변경사항이 없습니다', 'info'); return; }

  // 시각 피드백: 버튼 disable + 회전 아이콘 + 라벨 변경
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="sa-spin" style="display:inline-block;animation:sa-rotate 0.8s linear infinite">⟳</span> 저장 중...';

  try {
    await Promise.all(tasks);
    btn.innerHTML = '✓ 저장 완료';
    toast(`멀티${orgLabel('team')} 설정 ${tasks.length}건 저장 완료`, 'ok');

    // 멀티팀이 ON 으로 바뀌었으면 시스템 관리자 본인 브라우저의 last team 캐시 클리어 → 다음 / 진입 시 picker 표시
    if (cur.multi_team_enabled && !snap.multi_team_enabled) {
      try { localStorage.removeItem('wr_last_team'); } catch (_) {}
      toast(`멀티${olj('team','이')} 활성화되었습니다. 루트(/) 접속 시 ${orgLabel('team')} 선택 화면이 표시됩니다.`, 'info');
    }

    // 새 스냅샷으로 갱신 (다시 dirty 비교 기준)
    _saMtSnapshot = cur;

    // 1초 뒤 버튼 원복
    setTimeout(() => {
      btn.innerHTML = origHtml;
      _saMtUpdateDirty();
    }, 1100);
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function _saPutSetting(key, value) {
  return saApi(`/api/system-admin/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}

// (사용 안 함, saMultiTeamSave() 로 통합됨 — 하위호환 위해 유지)
async function saSaveVisibility() { return saMultiTeamSave(); }

async function seedSampleOrg() {
  // 운영 환경이면 추가 안전장치 — confirm 토큰 직접 입력 받음
  let isProd = false;
  try {
    const env = await saApi('/api/system-admin/env-info');
    isProd = !env.is_dev;
  } catch (_) {}

  if (isProd) {
    if (!confirm('⚠️ 지금 운영 환경(public 스키마)에 샘플 조직도(가상 인물)를 추가합니다.\n' +
                 '같은 (유닛, 이름) 조합은 skip 되어 기존 사용자 PIN·보고는 보존됩니다.\n' +
                 '계속하시겠습니까?')) return;
    const token = prompt('운영 적용 확인을 위해 다음 문자열을 정확히 입력해 주세요:\n\n  I-CONFIRM-SEED-PROD');
    if (token !== 'I-CONFIRM-SEED-PROD') {
      toast('확인 토큰이 일치하지 않아 취소합니다', 'err');
      return;
    }
  } else {
    if (!confirm('샘플 조직도(2그룹 · 3유닛 · 가상 인물 8명)를 등록합니다.\n' +
                 '같은 (유닛, 이름) 조합의 기존 멤버는 skip 됩니다.\n계속하시겠습니까?')) return;
  }

  showActionLoader('샘플 조직도 등록 중...');
  const resultEl = document.getElementById('saSeedResult');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }

  try {
    const body = isProd ? JSON.stringify({ confirm: 'I-CONFIRM-SEED-PROD' }) : JSON.stringify({});
    const res = await saApi('/api/system-admin/seed-sample-org', { method: 'POST', body });
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML =
        `✅ ${esc(res.message || '')}<br>` +
        `<span class="faint">그룹 ${res.divisions} · 유닛 ${res.teams} · ` +
        `멤버 신규 ${res.members_inserted} · skip ${res.members_skipped}</span>`;
    }
    toast('조직도 등록 완료', 'ok');
    // 4개 탭 모두 신규 데이터로 동기화 (전사현황 카드, 조직관리, 시스템 설정 노출 옵션 등)
    await saRefreshAll();
  } catch (e) {
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = `❌ 등록 실패: ${esc(e.message)}`;
    }
    toast('등록 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function syncFromProd() {
  // 체크된 테이블만 가져옴
  const checked = Array.from(document.querySelectorAll('.sa-sync-tbl:checked')).map(el => el.value);
  if (!checked.length) {
    toast('동기화할 테이블을 1개 이상 선택해주세요', 'err');
    return;
  }
  if (!confirm(`운영기(public) → 개발기(dev) 동기화\n\n대상: ${checked.join(', ')}\n\n선택한 테이블의 dev 데이터가 운영 데이터로 덮어써집니다.\n계속하시겠습니까?`)) return;

  showActionLoader('운영기 데이터 동기화 중...');
  const resultEl = document.getElementById('saSyncResult');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }

  try {
    const res = await saApi('/api/system-admin/sync-from-prod', {
      method: 'POST',
      body: JSON.stringify({ tables: checked }),
    });

    if (resultEl) {
      const tableList = res.synced.map(t => `${esc(t.table)}(${t.rows}건)`).join(', ');
      const errList   = res.errors.length
        ? `<br>⚠️ 오류: ${res.errors.map(e => esc(e.table) + ': ' + esc(e.error)).join(' / ')}`
        : '';
      resultEl.style.display = '';
      resultEl.innerHTML = `✅ ${esc(res.message)}<br><span style="color:var(--text2)">${tableList}</span>${errList}`;
    }
    toast('운영기 데이터 동기화 완료!', 'ok');
    // 4개 탭 모두 신규 데이터로 동기화
    await saRefreshAll();
  } catch (e) {
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = `❌ 동기화 실패: ${esc(e.message)}`;
    }
    toast('동기화 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function saveSaSystemSetting(key, value) {
  showActionLoader('설정 저장 중...');
  try {
    await saApi(`/api/system-admin/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
    toast('설정 저장 완료');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}


async function exportAllData() {
  try {
    const data = await saApi('/api/system-admin/export-all');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `weekly-report-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    toast('데이터 내보내기 완료', 'ok');
  } catch (e) {
    toast('내보내기 실패: ' + e.message, 'err');
  }
}

// ── 조직도 CSV 내려받기 (엑셀 편집용) ──────────────
// '﻿'(UTF-8 BOM) 를 앞에 붙여야 엑셀이 한글을 안 깨고 연다.
async function exportOrgCsv() {
  try {
    const res = await saApi('/api/system-admin/org-csv');
    const blob = new Blob(['﻿' + (res.csv || '')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `조직도_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('📥 조직도 CSV 내려받기 완료', 'ok');
  } catch (e) {
    toast('내려받기 실패: ' + e.message, 'err');
  }
}

// ── 조직 호칭 (org_labels) 편집 ──────────────
const _OL_FIELDS = { division: 'olDivision', team: 'olTeam', member: 'olMember', leader: 'olLeader', division_head: 'olDivisionHead' };
function loadOrgLabelEditor() {
  // 현재 적용된 라벨(utils.js ORG_LABELS)을 입력칸에 채움. 기본값과 같으면 빈칸(placeholder).
  const defaults = { division: '본부', team: '팀', member: '팀원', leader: '팀장', division_head: '본부장' };
  for (const [k, id] of Object.entries(_OL_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const cur = (typeof ORG_LABELS !== 'undefined' && ORG_LABELS[k]) || defaults[k];
    el.value = (cur === defaults[k]) ? '' : cur;
  }
}
async function saveOrgLabels() {
  const defaults = { division: '본부', team: '팀', member: '팀원', leader: '팀장', division_head: '본부장' };
  const obj = {};
  for (const [k, id] of Object.entries(_OL_FIELDS)) {
    const v = (document.getElementById(id)?.value || '').trim();
    obj[k] = v || defaults[k];   // 비우면 기본값
  }
  showActionLoader('조직 호칭 저장 중...');
  try {
    await _saPutSetting('org_labels', obj);
    if (typeof setOrgLabels === 'function') setOrgLabels(obj);   // 즉시 적용(data-ol 재주입)
    toast('✅ 조직 호칭이 저장되었습니다. 일부 화면은 새로고침 후 완전 반영됩니다.', 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ── 조직도 CSV 업로드 → 미리보기 → 반영 ──────────────
let _orgCsvText = '';   // 미리보기 후 [반영] 에서 재사용

async function importOrgCsvFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';   // 같은 파일 재선택 허용
  if (!file) return;
  showActionLoader('CSV 분석 중...');
  try {
    let txt = await file.text();
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);   // BOM 제거
    const res = await saApi('/api/system-admin/org-csv/preview', {
      method: 'POST', body: JSON.stringify({ csv: txt }),
    });
    if (!res.ok) {
      toast('CSV 오류: ' + (res.errors || []).slice(0, 3).join(' / '), 'err');
      return;
    }
    _orgCsvText = txt;
    _renderOrgPlan(res.plan);
    openModal('orgCsvModal');
  } catch (e) {
    toast('미리보기 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function _renderOrgPlan(plan) {
  const el = document.getElementById('orgCsvPlanBody');
  const sec = (title, items, fmt, color) => {
    if (!items || !items.length) return '';
    return `<div style="margin-bottom:10px"><b style="color:${color}">${title} (${items.length})</b><br>` +
           items.map(fmt).map(esc).join(', ') + '</div>';
  };
  let html = '';
  html += sec('🆕 그룹 추가', plan.groups.create, x => `${x.name}(그룹장:${x.head || '-'})`, 'var(--success)');
  html += sec('✏️ 그룹 변경', plan.groups.update, x => `${x.name}(그룹장:${x.head || '-'})`, 'var(--accent)');
  html += sec('🗑 그룹 삭제', plan.groups.delete, x => x.name, 'var(--danger)');
  html += sec('🆕 유닛 추가', plan.units.create, x => `${x.name}(${x.group || '그룹없음'})`, 'var(--success)');
  html += sec('🗑 유닛 삭제', plan.units.delete, x => x.name, 'var(--danger)');
  html += sec('🆕 멤버 추가', plan.members.create, x => `${x.name}(${x.unit})`, 'var(--success)');
  html += sec('🔀 멤버 이동', plan.members.move, x => `${x.name}: ${x.from}→${x.to}`, 'var(--accent)');
  html += sec('🗑 멤버 삭제', plan.members.delete, x => `${x.name}(${x.unit})`, 'var(--danger)');
  html += `<div style="margin-bottom:10px;color:var(--text2)">✏️ 정보 갱신(유지) 멤버: ${plan.members.update.length}명 / 유닛: ${plan.units.update.length}개</div>`;
  if (plan.warnings && plan.warnings.length) {
    html += '<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:color-mix(in oklab, var(--warn, #f59e0b) 10%, transparent)"><b>⚠️ 경고</b><br>' +
            plan.warnings.map(esc).join('<br>') + '</div>';
  }
  if (!html.trim()) html = '<span class="faint">변경 사항이 없습니다.</span>';
  el.innerHTML = html;
}

async function applyOrgCsv() {
  if (!_orgCsvText) { toast('업로드된 CSV가 없습니다.', 'err'); return; }
  if (!confirm('미리보기 내용대로 조직도를 반영합니다. 계속할까요?')) return;
  const btn = document.getElementById('orgCsvApplyBtn');
  if (btn) btn.disabled = true;
  showActionLoader('조직도 반영 중...');
  try {
    const res = await saApi('/api/system-admin/org-csv/apply', {
      method: 'POST', body: JSON.stringify({ csv: _orgCsvText }),
    });
    const s = res.stats || {};
    toast(`✅ 반영 완료 — 그룹 ${s.groups || 0}, 유닛 ${s.units || 0}, 멤버 ${s.members || 0} (이동 ${s.moved || 0}, 멤버삭제 ${s.deleted_members || 0}, 유닛삭제 ${s.deleted_units || 0})`, 'ok', 6000);
    closeModal('orgCsvModal');
    _orgCsvText = '';
    saLoadOrg().catch(() => {});
  } catch (e) {
    toast('반영 실패: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    hideActionLoader();
  }
}

// ── 시스템 관리자 전용 API 래퍼 ──────────────────

async function saApi(path, opts = {}) {
  const token = localStorage.getItem('wr_sysadmin_token') || localStorage.getItem('wr_token') || '';
  const headers = {
    'Content-Type': 'application/json',
    'X-Team-Slug': getTeamSlug(),
    ...(token ? { 'X-Auth-Token': token } : {}),
    ...opts.headers,
  };
  const res = await fetch(path, { headers, cache: 'no-store', ...opts });
  if (res.status === 401 || res.status === 403) {
    toast('권한이 없습니다. 다시 로그인해주세요.', 'err');
    localStorage.removeItem('wr_sysadmin_token');
    showPage('pgLogin');
    throw new Error('인증 오류');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || err.message || '요청 실패');
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


// ═══════════════════════════════════════════════════════════
//  전사 구성원 관리 (31차) — 조회·필터·일괄 인사조치
//  입사/퇴사/인사이동/겸직/PIN 을 한 화면에서. 그룹장·유닛장 지정의 조회원이기도 하다.
// ═══════════════════════════════════════════════════════════
let _mmAll = [];             // 전체 구성원 (서버 원본)
let _mmSelected = new Set(); // 선택된 member id
let _mmView = 'tree';        // 'tree'(조직도) | 'flat'(전체 목록)
let _mmScope = { type: 'all', key: '' };   // 선택 조직: all | div(그룹명) | team(팀명)

async function openMemberMaster() {
  openModal('memberMasterModal');
  _mmView = 'tree';
  _mmScope = { type: 'all', key: '' };
  mmSetView('tree');
  // 유닛장·주보관리자 메타 표시에 saOrg 가 필요 — 아직 없으면 먼저 로드
  if (typeof saOrg === 'undefined' || !saOrg || !Array.isArray(saOrg.teams) || !saOrg.teams.length) {
    try { await saLoadOrg(); } catch (_) {}
  }
  await loadMemberMaster();
}

async function loadMemberMaster() {
  const list = document.getElementById('mmList');
  if (list) list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px"><span class="spin" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>구성원 목록을 불러오는 중...</div>`;
  try {
    const res = await saApi('/api/system-admin/members');
    _mmAll = res.members || [];
    _mmSelected.clear();
    _mmFillFilters();
    renderMemberMaster();
  } catch (e) {
    if (list) list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);font-size:13px">조회 실패: ${esc(e.message || '')}</div>`;
  }
}

// 필터 드롭다운 옵션을 실제 데이터에서 생성 (없는 값은 노출하지 않음)
function _mmFillFilters() {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const fill = (id, vals, keepFirst = true) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    const first = keepFirst ? sel.querySelector('option') : null;
    const opts = vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.innerHTML = (first ? first.outerHTML : '') + opts;
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  fill('mmFilterOrg', uniq(_mmAll.map(m => m.team_name)));
  fill('mmFilterPos', uniq(_mmAll.map(m => m.position)));
  fill('mmFilterTitle', uniq(_mmAll.map(m => m.title)));
  fill('mmFilterYear', uniq(_mmAll.map(m => (m.join_date || '').slice(0, 4))));
  // 이동/겸직 대상 조직 — 그룹 직속 컨테이너도 대상에 포함 (그룹 직속 배치 지원)
  const tsel = document.getElementById('mmTargetTeam');
  if (tsel && typeof saOrg !== 'undefined' && saOrg.teams) {
    const cur = tsel.value;
    tsel.innerHTML = '<option value="">이동/겸직 대상 조직</option>' + saOrg.teams.map(t =>
      `<option value="${esc(t.slug)}">${esc(_saIsHqTeam(t) ? t.name + ' 직속' : t.name)}</option>`).join('');
    if ([...tsel.options].some(o => o.value === cur)) tsel.value = cur;
  }
}

function _mmFiltered() {
  const q = (document.getElementById('mmSearch')?.value || '').trim().toLowerCase();
  const org = document.getElementById('mmFilterOrg')?.value || '';
  const pos = document.getElementById('mmFilterPos')?.value || '';
  const title = document.getElementById('mmFilterTitle')?.value || '';
  const year = document.getElementById('mmFilterYear')?.value || '';
  const pin = document.getElementById('mmFilterPin')?.value || '';
  const status = document.getElementById('mmFilterStatus')?.value ?? 'active';
  const target = document.getElementById('mmFilterTarget')?.value || '';
  return _mmAll.filter(m => {
    if (q && !(m.name || '').toLowerCase().includes(q)) return false;
    if (org && m.team_name !== org) return false;
    if (pos && m.position !== pos) return false;
    if (title && m.title !== title) return false;
    if (year && (m.join_date || '').slice(0, 4) !== year) return false;
    if (pin === 'y' && !m.has_pin) return false;
    if (pin === 'n' && m.has_pin) return false;
    if (status === 'active' && m.is_active === false) return false;
    if (status === 'inactive' && m.is_active !== false) return false;
    if (target === 'y' && m.is_report_target === false) return false;
    if (target === 'n' && m.is_report_target !== false) return false;
    return true;
  });
}

// 입사일 → 연차 (당해 1월 1일 기준 만 년차). 빈 값이면 '-'
function _mmYears(joinDate) {
  if (!joinDate || joinDate.length < 4) return '';
  const y = parseInt(joinDate.slice(0, 4), 10);
  if (!y) return '';
  const n = new Date().getFullYear() - y + 1;
  return `${n}년차`;
}

// 보기 전환: 조직도(트리) ↔ 전체 목록(평면)
function mmSetView(v) {
  _mmView = v;
  document.getElementById('mmViewTree')?.classList.toggle('active', v === 'tree');
  document.getElementById('mmViewFlat')?.classList.toggle('active', v === 'flat');
  const tree = document.getElementById('mmTree');
  if (tree) tree.classList.toggle('hidden', v !== 'tree');
  if (v === 'flat') _mmScope = { type: 'all', key: '' };
  renderMemberMaster();
}

// 조직 선택 (트리 클릭)
function mmSelectScope(type, key) {
  _mmScope = { type, key: key || '' };
  renderMemberMaster();
}

// 좌측 조직 트리 — 그룹 › 유닛, 각 노드에 인원수(현재 필터 반영)
function _mmRenderTree(pool) {
  const el = document.getElementById('mmTree');
  if (!el) return;
  if (_mmView !== 'tree') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  // 그룹 → 유닛 집계 (조직 순서는 서버 정렬 순서를 그대로 따름)
  const divs = [];
  const dmap = new Map();
  for (const m of pool) {
    const dname = m.division_name || `${orgLabel('division')} 미지정`;
    if (!dmap.has(dname)) { dmap.set(dname, { name: dname, count: 0, units: new Map() }); divs.push(dmap.get(dname)); }
    const d = dmap.get(dname);
    d.count++;
    const tname = m.team_name;
    if (!d.units.has(tname)) d.units.set(tname, { name: tname, count: 0, direct: !!m.is_division_direct });
    d.units.get(tname).count++;
  }

  // onclick 인라인에 조직명을 넣으면 따옴표·특수문자로 속성이 깨진다(SyntaxError).
  // → data-* 로 값을 싣고 이벤트 위임으로 처리한다.
  const act = (t, k) => (_mmScope.type === t && _mmScope.key === k) ? ' active' : '';
  let html = `<div class="mm-tnode${act('all', '')}" data-t="all" data-k="">
      <span>전체</span><span class="mm-tcount">${pool.length}</span></div>`;
  for (const d of divs) {
    html += `<div class="mm-tnode grp${act('div', d.name)}" data-t="div" data-k="${esc(d.name)}">
        <span>🏢 ${esc(d.name)}</span><span class="mm-tcount">${d.count}</span></div>`;
    for (const u of d.units.values()) {
      html += `<div class="mm-tnode unit${act('team', u.name)}" data-t="team" data-k="${esc(u.name)}">
          <span>${u.direct ? '👑 직속' : esc(u.name)}</span><span class="mm-tcount">${u.count}</span></div>`;
    }
  }
  el.innerHTML = html;
  if (!el.dataset.bound) {
    el.addEventListener('click', (e) => {
      const node = e.target.closest('.mm-tnode');
      if (node) mmSelectScope(node.dataset.t, node.dataset.k);
    });
    el.dataset.bound = '1';
  }
}

// 선택 조직으로 좁히기
function _mmScoped(pool) {
  if (_mmView !== 'tree' || _mmScope.type === 'all') return pool;
  if (_mmScope.type === 'div') return pool.filter(m => (m.division_name || `${orgLabel('division')} 미지정`) === _mmScope.key);
  return pool.filter(m => m.team_name === _mmScope.key);
}

function _mmRowHtml(m) {
  const badges =
    (m.is_division_head ? `<span class="mm-badge head">${orgLabel('division_head')}</span>` : '') +
    (m.is_leader ? `<span class="mm-badge leader">${orgLabel('leader')}</span>` : '') +
    (m.is_dual ? `<span class="mm-badge dual">겸직</span>` : '') +
    (m.is_active === false ? `<span class="mm-badge off">퇴사</span>` : '') +
    (m.is_report_target === false ? `<span class="mm-badge off">집계제외</span>` : '');
  const org = m.is_division_direct ? `${esc(m.team_name)} 직속` : esc(m.team_name);
  return `<div class="mm-row${m.is_active === false ? ' inactive' : ''}">
      <input type="checkbox" ${_mmSelected.has(m.id) ? 'checked' : ''} onchange="mmToggle(${m.id}, this.checked)">
      <span class="mm-name">${esc(m.name)}${badges}</span>
      <span><span>${org}</span>${m.division_name ? `<div class="mm-sub">${esc(m.division_name)}</div>` : ''}</span>
      <span class="mm-col-hide mm-cell-sel">
        <select class="mm-mini" title="직급" onchange="mmSetField(${m.id}, 'position', this.value)">
          ${_mmOpts(_SA_POSITION_OPTIONS, m.position)}
        </select>
        <select class="mm-mini" title="직책" onchange="mmSetField(${m.id}, 'title', this.value)">
          ${_mmOpts(_SA_TITLE_OPTIONS, m.title)}
        </select>
      </span>
      <span class="mm-col-hide mm-sub" title="클릭해 입사일 수정" style="cursor:pointer" onclick="mmEditJoinDate(${m.id})">${m.join_date ? `${esc(m.join_date)}<div class="mm-sub">${_mmYears(m.join_date)}</div>` : '<span style="color:var(--text3)">입력</span>'}</span>
      <span class="mm-sub">${m.has_pin ? '<span style="color:#16a34a">PIN 등록</span>' : '<span style="color:var(--text3)">PIN 미등록</span>'}</span>
    </div>`;
}

// select 옵션 생성 — 현재 값이 옵션에 없으면(구 데이터) 임시로 추가해 유실 방지
function _mmOpts(list, cur) {
  const opts = Array.isArray(list) ? list.slice() : [''];
  if (!opts.includes('')) opts.unshift('');
  if (cur && !opts.includes(cur)) opts.push(cur);
  return opts.map(o =>
    `<option value="${esc(o)}"${o === (cur || '') ? ' selected' : ''}>${o ? esc(o) : '—'}</option>`
  ).join('');
}

// 직급/직책 인라인 저장 (콤보박스 변경 즉시 반영)
async function mmSetField(id, field, value) {
  const m = _mmAll.find(x => x.id === id);
  if (!m) return;
  const prev = m[field] || '';
  if (prev === value) return;
  m[field] = value;                       // 낙관적 반영 (재렌더 없이 선택 상태 유지)
  try {
    await saApi(`/api/system-admin/members/${id}/profile`, {
      method: 'PUT', body: JSON.stringify({ [field]: value }),
    });
    toast(`✅ ${m.name} ${field === 'position' ? '직급' : '직책'} 저장`, 'ok');
    _mmFillFilters();
  } catch (e) {
    m[field] = prev;                      // 실패 시 롤백
    renderMemberMaster();
    toast('저장 실패: ' + e.message, 'err');
  }
}

function renderMemberMaster() {
  const list = document.getElementById('mmList');
  if (!list) return;
  const pool = _mmFiltered();          // 검색·필터 적용 (트리 인원수도 이 기준)
  _mmRenderTree(pool);
  const rows = _mmScoped(pool);        // 선택 조직으로 좁힘

  const cntEl = document.getElementById('mmCount');
  if (cntEl) cntEl.textContent = `· ${rows.length}명 / 전체 ${_mmAll.length}명`;

  // 상단 경로 + 조직 메타 (유닛 선택 시 유닛장·주보관리자 표시)
  let crumb = '';
  if (_mmView === 'tree' && _mmScope.type !== 'all') {
    const first = rows[0];
    const path = _mmScope.type === 'div'
      ? esc(_mmScope.key)
      : `${esc(first?.division_name || '')} <span style="color:var(--text3)">›</span> ${esc(_mmScope.key)}`;
    let meta = `${rows.length}명`;
    if (_mmScope.type === 'team' && typeof saOrg !== 'undefined' && saOrg.teams) {
      const t = saOrg.teams.find(x => x.name === _mmScope.key);
      if (t) {
        if (t.leader_name) meta += ` · ${orgLabel('leader')} ${esc(t.leader_name)}`;
        const ras = [t.report_admin_primary, t.report_admin_secondary].filter(Boolean).map(esc).join(', ');
        if (ras) meta += ` · 주보관리 ${ras}`;
      }
    }
    crumb = `<div class="mm-crumb"><div class="mm-crumb-path">${path}</div><div class="mm-crumb-meta">${meta}</div></div>`;
  }

  let html = crumb + `<div class="mm-row head">
    <span></span><span>이름</span><span>소속</span>
    <span class="mm-col-hide">직급 · 직책</span><span class="mm-col-hide">입사</span><span>상태</span></div>`;

  if (!rows.length) {
    html += `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">조건에 맞는 구성원이 없습니다.</div>`;
  } else if (_mmView === 'tree' && _mmScope.type === 'div') {
    // 그룹 선택: 하위 전원을 유닛별 구분선으로 묶어 표시 (그룹장/직속이 먼저)
    const groups = new Map();
    for (const m of rows) {
      const k = m.team_name;
      if (!groups.has(k)) groups.set(k, { direct: !!m.is_division_direct, items: [] });
      groups.get(k).items.push(m);
    }
    const ordered = [...groups.entries()].sort((a, b) => (b[1].direct ? 1 : 0) - (a[1].direct ? 1 : 0));
    for (const [tname, g] of ordered) {
      html += `<div class="mm-sec">${g.direct ? `👑 ${esc(tname)} 직속` : esc(tname)} · ${g.items.length}명</div>`;
      html += g.items.map(_mmRowHtml).join('');
    }
  } else {
    html += rows.map(_mmRowHtml).join('');
  }

  list.innerHTML = html;
  _mmUpdateBulkBar();
}

function mmToggle(id, on) {
  if (on) _mmSelected.add(id); else _mmSelected.delete(id);
  _mmUpdateBulkBar();
}
function mmToggleAll(on) {
  const rows = _mmScoped(_mmFiltered());   // 현재 보이는 조직 범위만
  if (on) rows.forEach(m => _mmSelected.add(m.id));
  else rows.forEach(m => _mmSelected.delete(m.id));
  renderMemberMaster();
}
function _mmUpdateBulkBar() {
  const bar = document.getElementById('mmBulkBar');
  const cnt = document.getElementById('mmSelCount');
  if (!bar) return;
  bar.style.display = _mmSelected.size ? '' : 'none';
  if (cnt) cnt.textContent = `${_mmSelected.size}명 선택됨`;
}

async function mmEditJoinDate(id) {
  const m = _mmAll.find(x => x.id === id);
  if (!m) return;
  const v = (prompt(`${m.name} 님의 입사일을 입력하세요 (YYYY-MM-DD 또는 YYYY)`, m.join_date || '') || '').trim();
  if (v === '') return;
  const norm = /^\d{4}$/.test(v) ? `${v}-01-01` : v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) { toast('YYYY-MM-DD 형식으로 입력해주세요', 'err'); return; }
  showActionLoader('입사일 저장 중...');
  try {
    await saApi(`/api/system-admin/members/${id}/profile`, {
      method: 'PUT', body: JSON.stringify({ join_date: norm }),
    });
    m.join_date = norm;
    _mmFillFilters();
    renderMemberMaster();
    toast('✅ 입사일이 저장되었습니다', 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally { hideActionLoader(); }
}

const _MM_LABEL = {
  move: '인사이동', dual: '겸직 추가', deactivate: '퇴사 처리', activate: '복직',
  reset_pin: 'PIN 초기화', set_target: '집계 대상 변경', set_visible: '노출 변경', delete: '삭제',
};

async function mmBulk(action, value) {
  if (!_mmSelected.size) { toast('대상을 선택해주세요', 'err'); return; }
  const ids = [..._mmSelected];
  const label = _MM_LABEL[action] || action;
  const slug = document.getElementById('mmTargetTeam')?.value || '';
  if ((action === 'move' || action === 'dual') && !slug) {
    toast('이동/겸직 대상 조직을 선택해주세요', 'err'); return;
  }
  const tName = slug ? (document.getElementById('mmTargetTeam').selectedOptions[0]?.textContent || slug) : '';
  let msg = `선택한 ${ids.length}명을 [${label}] 처리합니다.`;
  if (action === 'move') msg += `\n대상 조직: ${tName} (PIN 도 함께 이동)`;
  if (action === 'dual') msg += `\n추가 소속: ${tName} (기존 소속 유지)`;
  if (action === 'deactivate') msg += `\n로그인·목록에서 제외되지만 작성한 주간보고 이력은 보존됩니다.`;
  if (action === 'delete') msg += `\n⚠️ 완전 삭제입니다. 과거 보고 이력이 있으면 퇴사 처리를 권장합니다.`;
  if (!confirm(msg + '\n계속하시겠습니까?')) return;

  showActionLoader(`${label} 처리 중...`);
  try {
    const r = await saApi('/api/system-admin/members/bulk', {
      method: 'POST',
      body: JSON.stringify({ member_ids: ids, action, target_team_slug: slug, value: value !== false }),
    });
    let m = `✅ ${label} 완료 — ${r.affected}명`;
    if (r.skipped && r.skipped.length) m += ` / 건너뜀 ${r.skipped.length}건`;
    toast(m, 'ok');
    (r.warnings || []).forEach(w => setTimeout(() => toast('⚠️ ' + w, 'info'), 600));
    if (r.skipped && r.skipped.length) {
      setTimeout(() => toast('건너뜀: ' + r.skipped.join(', '), 'info'), 1200);
    }
    _mmSelected.clear();
    await loadMemberMaster();
    if (typeof saLoadOrg === 'function') saLoadOrg();   // 조직 카드 인원수 동기화
  } catch (e) {
    toast(`${label} 실패: ` + e.message, 'err');
  } finally { hideActionLoader(); }
}
