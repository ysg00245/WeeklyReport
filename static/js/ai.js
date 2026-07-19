// ── AI 프롬프트 편집 ───────────────────────
// 일반 관리자 화면(양식 설정 탭)에서는 팀별 추가 지침만 편집. 전역 시스템 프롬프트
// (페르소나/포맷 등)는 시스템 관리자 콘솔의 AI 프롬프트 탭에서 편집.
let _aiPromptDefaults = null;
let _aiPromptCurrent = {};
let memberPromptMode = 'individual';

// 팀별 추가 지침 4종 → textarea 매핑
const _AI_EXTRA_KEYS = {
  'ai_team_extra_persona': 'aiExtraPersonaTxt',
  'ai_team_extra_member':  'aiExtraMemberTxt',
  'ai_team_extra_project': 'aiExtraProjectTxt',
  'ai_team_extra_team':    'aiExtraTeamTxt',
};

async function loadAiPrompts(force = false) {
  // 탭 토글마다 재조회하지 않음 — 저장/초기화 후에만 force 재조회.
  // (프롬프트는 관리자 본인이 저장할 때만 바뀌는 준정적 데이터)
  if (!force && _aiPromptDefaults) return true;
  try {
    const data = await api('/api/ai/prompts');
    if (!data || !data.defaults) {
      throw new Error('서버 응답에 defaults가 없습니다');
    }
    _aiPromptDefaults = data.defaults;
    _aiPromptCurrent = data.current || {};

    // 팀별 추가 지침 4종 textarea 채움 (전역 프롬프트는 시스템 관리자 전용)
    for (const [key, txtId] of Object.entries(_AI_EXTRA_KEYS)) {
      const el = document.getElementById(txtId);
      if (el) el.value = _aiPromptCurrent[key] || '';
    }

    return true;
  } catch (e) {
    console.error('AI 프롬프트 로드 실패:', e);
    toast('AI 프롬프트 로드 실패: ' + (e.message || '서버 응답 없음'), 'err');
    _aiPromptDefaults = null;
    return false;
  }
}

// 팀별 추가 지침 — 개별 키 저장
async function saveExtraPrompt(key, txtId) {
  showActionLoader('추가 지침 저장 중...');
  try {
    const val = document.getElementById(txtId).value;
    await api(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ key, value: JSON.stringify(val || '') }),
    });
    toast('✅ 저장되었습니다', 'ok');
    await loadAiPrompts(true);
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 팀별 추가 지침 — 개별 키 초기화 (저장 안 함, 사용자가 저장 버튼 눌러야 반영)
function resetExtraPrompt(key) {
  const txtId = _AI_EXTRA_KEYS[key];
  const el = txtId && document.getElementById(txtId);
  if (el) {
    el.value = '';
    toast('내용을 비웠습니다. 저장 버튼을 눌러야 반영됩니다.', 'info');
  }
}

function setMemberPromptMode(mode) {
  // 현재 작업 중인 내용 임시 저장 (전환 전)
  const currentVal = document.getElementById('aiFormatMemberTxt').value;
  const oldKey = memberPromptMode === 'individual' ? 'ai_format_member_individual' : 'ai_format_member_group';
  _aiPromptCurrent[oldKey] = currentVal;

  memberPromptMode = mode;
  updateMemberPromptEditor();
}

function updateMemberPromptEditor() {
  const indBtn = document.getElementById('memberPromptIndividual');
  const grpBtn = document.getElementById('memberPromptGroup');
  const txt = document.getElementById('aiFormatMemberTxt');
  
  if (memberPromptMode === 'individual') {
    indBtn.style.background = 'var(--accent)';
    indBtn.style.color = '#fff';
    grpBtn.style.background = 'var(--bg2)';
    grpBtn.style.color = 'var(--text2)';
    txt.value = _aiPromptCurrent.ai_format_member_individual || '';
  } else {
    grpBtn.style.background = 'var(--accent)';
    grpBtn.style.color = '#fff';
    indBtn.style.background = 'var(--bg2)';
    indBtn.style.color = 'var(--text2)';
    txt.value = _aiPromptCurrent.ai_format_member_group || '';
  }
}

async function saveActiveMemberPrompt() {
  const key = memberPromptMode === 'individual' ? 'ai_format_member_individual' : 'ai_format_member_group';
  await saveIndividualPrompt(key, 'aiFormatMemberTxt');
}

async function resetActiveMemberPrompt() {
  const key = memberPromptMode === 'individual' ? 'ai_format_member_individual' : 'ai_format_member_group';
  const el = document.getElementById('aiFormatMemberTxt');
  if (_aiPromptDefaults && _aiPromptDefaults[key]) {
    el.value = _aiPromptDefaults[key];
    toast('기본값으로 복원했습니다 (저장 버튼을 눌러야 적용됨)', 'ok');
  } else {
    toast('기본값을 찾을 수 없습니다.', 'err');
  }
}

async function resetPrompt(key) {
  // 기본값 캐시가 비어있으면 한 번 더 로드 시도
  if (!_aiPromptDefaults || !_aiPromptDefaults[key]) {
    const ok = await loadAiPrompts();
    if (!ok || !_aiPromptDefaults || !_aiPromptDefaults[key]) {
      toast('기본값을 불러오지 못했습니다 (서버 로그를 확인해주세요)', 'err');
      return;
    }
  }
  const map = {
    'ai_persona': 'aiPersonaTxt',
    'ai_format_member': 'aiFormatMemberTxt',
    'ai_format_project': 'aiFormatProjectTxt',
    'ai_format_team': 'aiFormatTeamTxt',
  };
  const el = document.getElementById(map[key]);
  if (el) {
    el.value = _aiPromptDefaults[key];
    toast('기본값으로 복원했습니다 (저장 버튼을 눌러야 적용됨)', 'ok');
  }
}

async function saveAiPrompts() {
  const items = [
    ['ai_persona',           document.getElementById('aiPersonaTxt').value],
    ['ai_format_member',     document.getElementById('aiFormatMemberTxt').value],
    ['ai_format_project',    document.getElementById('aiFormatProjectTxt').value],
    ['ai_format_team',       document.getElementById('aiFormatTeamTxt').value],
  ];
  showActionLoader('AI 프롬프트 저장 중...');
  try {
    for (const [key, val] of items) {
      await api(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ key, value: JSON.stringify(val || '') }),
      });
    }
    toast('✅ 모든 AI 프롬프트가 저장되었습니다', 'ok');
    await loadAiPrompts(true);
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// 개별 항목 저장 기능
async function saveIndividualPrompt(key, customId = null) {
  showActionLoader('프롬프트 저장 중...');
  try {
    const txtId = customId || {
      'ai_persona': 'aiPersonaTxt',
      'ai_format_project': 'aiFormatProjectTxt',
      'ai_format_team': 'aiFormatTeamTxt',
      'ai_format_member_individual': 'aiFormatMemberTxt',
      'ai_format_member_group': 'aiFormatMemberTxt'
    }[key];
    const val = document.getElementById(txtId).value;
    await api(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ key, value: JSON.stringify(val || '') }),
    });
    toast('✅ 해당 항목이 저장되었습니다', 'ok');
    await loadAiPrompts(true);
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  AI 요약 (서버 API 호출)
// ═══════════════════════════════════════

let aiMode = 'member'; // 'member' | 'project' | 'team'
let aiSubMode = 'individual'; // 'individual' | 'group' (팀원별 하위)
let aiProjMode = 'section'; // 'section'(B: 프로젝트 헤더 + 3열 표) | 'flat'(A: 프로젝트명이 첫 컬럼인 단일 4열 표)
let currentAiMarkdown = ''; // 복사용 원본 마크다운 저장

function getEffectiveAiMode() {
  // 팀원 요약은 요청자(관리자/주보관리자/팀장) 무관하게 동일한 공용본 — 저장/조회 키 동일.
  // (팀장 본인 보고 병합은 별도 '최종 취합' 기능에서만, 다른 키로 저장 예정)
  if (aiMode === 'member')  return `member_${aiSubMode}`;
  if (aiMode === 'project') return aiProjMode === 'flat' ? 'project_flat' : 'project';
  return aiMode;
}
function setAiMode(mode) {
  // 같은 모드 재클릭 → 하위 토글 (팀원별: 개인/그룹, 프로젝트별: 섹션형/단일표)
  if (aiMode === mode) {
    if (mode === 'member')  toggleAiSubMode();
    if (mode === 'project') toggleAiProjSubMode();
    return;
  }

  aiMode = mode;
  const memberBtn = document.getElementById('aiModeMember');
  const projectBtn = document.getElementById('aiModeProject');
  const teamBtn = document.getElementById('aiModeTeam');
  const subBtn = document.getElementById('aiMemberSubMode');
  const projSubBtn = document.getElementById('aiProjSubMode');

  [memberBtn, projectBtn, teamBtn].forEach(btn => {
    btn.style.background = 'var(--surface2)';
    btn.style.color = 'var(--text2)';
    btn.classList.remove('active');
  });

  const activeBtn = mode === 'member' ? memberBtn : (mode === 'project' ? projectBtn : teamBtn);
  activeBtn.style.background = 'var(--accent)';
  activeBtn.style.color = '#fff';
  activeBtn.classList.add('active');

  // 하위 토글: 팀원별 → 개인/그룹, 프로젝트별 → 섹션형/단일표, 팀별 → 없음
  if (subBtn)     subBtn.style.display     = (mode === 'member')  ? 'block' : 'none';
  if (projSubBtn) projSubBtn.style.display = (mode === 'project') ? 'block' : 'none';

  const wk = document.getElementById('adminWeekSel').value;
  if (wk) loadSavedSummary(wk);
}

function toggleAiSubMode() {
  const btn = document.getElementById('aiMemberSubMode');
  if (aiSubMode === 'individual') {
    aiSubMode = 'group';
    btn.textContent = '그룹화';
    btn.style.color = 'var(--accent)';
    btn.style.borderColor = 'var(--accent)';
  } else {
    aiSubMode = 'individual';
    btn.textContent = '개인별';
    btn.style.color = 'var(--text2)';
    btn.style.borderColor = 'var(--border)';
  }
  const wk = document.getElementById('adminWeekSel').value;
  if (wk) loadSavedSummary(wk);
}

// 프로젝트별 하위 토글: 섹션형(B, 기본) ↔ 단일표(A)
function toggleAiProjSubMode() {
  const btn = document.getElementById('aiProjSubMode');
  if (aiProjMode === 'section') {
    aiProjMode = 'flat';
    if (btn) { btn.textContent = '단일표'; btn.style.color = 'var(--accent)'; btn.style.borderColor = 'var(--accent)'; }
  } else {
    aiProjMode = 'section';
    if (btn) { btn.textContent = '섹션형'; btn.style.color = 'var(--text2)'; btn.style.borderColor = 'var(--border)'; }
  }
  const wk = document.getElementById('adminWeekSel').value;
  if (wk) loadSavedSummary(wk);
}

// ── AI 생성 진행 표시 (의사 진행률 — 예상 소요시간 기반 점근, 완료 시 100%) ──
let _aiProgTimer = null;
function _aiProgressStart(box, label, expectSec = 35) {
  _aiProgressStop();
  box.innerHTML =
    `<div class="ai-prog">` +
    `<div class="ai-prog-row"><span class="spin"></span>` +
    `<span class="ai-prog-stage" id="aiProgStage">보고 데이터 수집 중...</span>` +
    `<span class="ai-prog-pct" id="aiProgPct">0%</span></div>` +
    `<div class="ai-prog-bar"><span id="aiProgFill" style="width:0%"></span></div>` +
    `<div class="ai-prog-sub" id="aiProgSub">${label} · 보통 ${expectSec}초 내외 소요</div>` +
    `</div>`;
  const t0 = Date.now();
  const stages = [
    [0,  '보고 데이터 수집 중...'],
    [12, 'AI 가 내용 분석 중...'],
    [45, '요약 문서 구성 중...'],
    [80, '표·문장 다듬는 중...'],
  ];
  _aiProgTimer = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    // 점근 진행률: expectSec 시점에 ~85%, 이후 97% 까지 서서히
    const pct = Math.min(97, Math.round(100 * (1 - Math.exp(-1.9 * sec / expectSec))));
    const fill = document.getElementById('aiProgFill');
    const pctEl = document.getElementById('aiProgPct');
    const stEl = document.getElementById('aiProgStage');
    const subEl = document.getElementById('aiProgSub');
    if (!fill) { _aiProgressStop(); return; }   // 박스가 교체되면 중단
    fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (stEl) { let s = stages[0][1]; for (const [p, tx] of stages) if (pct >= p) s = tx; stEl.textContent = s; }
    if (subEl) subEl.textContent = `${label} · ${Math.round(sec)}초 경과 (보통 ${expectSec}초 내외)`;
  }, 400);
}
function _aiProgressStop() {
  if (_aiProgTimer) { clearInterval(_aiProgTimer); _aiProgTimer = null; }
}

async function genAllSummary() {
  const wk = document.getElementById('adminWeekSel').value;
  const box = document.getElementById('allAiContent');
  const modeLabel = aiMode === 'project' ? '프로젝트별' : `${orgLabel('member')}별`;
  _aiProgressStart(box, `전체 요약 생성 (${modeLabel})`);
  document.getElementById('allAiBox')?.classList.add('generating');
  document.getElementById('allAiBody').classList.remove('collapsed');
  document.getElementById('allAiChev').style.transform = '';

  try {
    const res = await api(`/api/ai/summarize?mode=${encodeURIComponent(aiMode)}`, {
      method: 'POST',
      body: JSON.stringify({ week_key: wk, summary_type: getEffectiveAiMode() }),
    });
    currentAiMarkdown = res.summary; // 원본 마크다운 저장
    _aiProgressStop();
    box.innerHTML = md2html(res.summary);
    box.style.color = '';

    // 자동 저장 수행
    try {
      await api('/api/ai/summary', {
        method: 'POST',
        body: JSON.stringify({ 
          week_key: wk, 
          summary_content: res.summary,
          summary_type: getEffectiveAiMode()
        })
      });
    } catch (saveErr) {
      console.error('자동 저장 실패:', saveErr);
    }
  } catch(e) {
    _aiProgressStop();
    box.innerHTML = `<span style="color:var(--danger)">요약 실패: ${e.message}</span>`;
  } finally {
    _aiProgressStop();
    document.getElementById('allAiBox')?.classList.remove('generating');
  }
}

function toggleAllAi() {
  const body = document.getElementById('allAiBody');
  const chev = document.getElementById('allAiChev');
  const collapsed = body.classList.toggle('collapsed');
  chev.style.transform = collapsed ? 'rotate(180deg)' : '';
}

async function copyAiSummary() {
  if (!currentAiMarkdown || currentAiMarkdown.includes('새로 생성')) {
    toast('요약된 내용이 없습니다.', 'err');
    return;
  }
  try {
    await navigator.clipboard.writeText(currentAiMarkdown);
    toast('📋 AI 요약이 원본 텍스트로 복사되었습니다.', 'ok');
  } catch (err) {
    toast('복사에 실패했습니다.', 'err');
  }
}

function downloadAiSummary() {
  if (!currentAiMarkdown || !currentAiMarkdown.trim()) {
    toast('다운로드할 요약 내용이 없습니다.', 'err');
    return;
  }
  const wk = document.getElementById('adminWeekSel')?.value || 'summary';
  const filename = `주간보고_AI요약_${wk}.md`;
  const blob = new Blob([currentAiMarkdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast(`📥 ${filename} 다운로드 완료`, 'ok');
}

async function saveAiSummary() {
  const wk = document.getElementById('adminWeekSel').value;
  // 원본 마크다운 우선 — innerText(렌더 결과)를 저장하면 표/서식이 깨진 일반 텍스트로 덮어써짐
  const content = currentAiMarkdown || document.getElementById('allAiContent').innerText;
  if (!content || content.includes('전체 요약 생성')) {
    toast('저장할 요약 내용이 없습니다.', 'err');
    return;
  }
  showActionLoader('요약 저장 중...');
  try {
    await api('/api/ai/summary', {
      method: 'POST',
      body: JSON.stringify({
        week_key: wk,
        summary_content: content,
        summary_type: getEffectiveAiMode()
      })
    });
    toast('💾 요약 내용이 DB에 저장되었습니다.', 'ok');
  } catch (err) {
    toast('저장 실패: ' + err.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function loadSavedSummary(wk) {
  const box = document.getElementById('allAiContent');
  box.innerHTML = `<span class="ai-loading"><span class="spin"></span> 불러오는 중...</span>`;
  try {
    const res = await api(`/api/ai/summary?week=${wk}&type=${getEffectiveAiMode()}`);
    if (res.summary) {
      currentAiMarkdown = res.summary;
      box.innerHTML = md2html(res.summary);
      box.style.color = '';
    } else {
      box.innerHTML = '<span style="color:var(--text3);font-size:12px">저장된 요약이 없습니다. [새로 생성] 버튼을 눌러주세요.</span>';
    }
  } catch (err) {
    box.innerHTML = '<span style="color:var(--text3);font-size:12px">저장된 요약이 없습니다. [새로 생성] 버튼을 눌러주세요.</span>';
    console.error('요약 로드 실패:', err);
  }
}

// ═══════════════════════════════════════
//  최종 취합 (결재권자 전용) — 확정 팀원 요약본 + 팀장 본인 보고 병합
// ═══════════════════════════════════════
// 주차 소스: 현황 탭 주차 선택(adminWeekSel, 팀원 요약이 생성·저장되는 기준) 우선.
function _finalMergeWeek() {
  return (document.getElementById('adminWeekSel')?.value)
      || (typeof currentWriteWeek !== 'undefined' ? currentWriteWeek : '')
      || '';
}
// 본인(결재권자) 주간보고 존재 여부 — 가이드 분기용. null=미확인
let _fmMyReport = null;
async function _fmCheckMyReport() {
  const wk = _finalMergeWeek();
  if (!wk) { _fmMyReport = null; return; }
  try { _fmMyReport = !!(await api(`/api/reports/my?week=${wk}`)); }
  catch { _fmMyReport = false; }
}

// 현황 탭 CTA 배너 — 결재권자에게만 노출, 본인 보고 상태로 문구/펄스 전환
// 결재 상태 칩 렌더 — 배너(현황 탭)와 사이드 카드(작성 탭)에 동일 적용. 팝업 없이도 승인/보완요청이 보인다.
function _fmRenderReviewChips(st) {
  const chips = [
    document.getElementById('fmCtaReview'),      // 현황 탭 배너
    document.getElementById('fmCtaSideReview'),  // 작성 탭 사이드 카드
    document.getElementById('fmModalReview'),    // 최종 취합 모달 상단 (히어로 아래)
  ];
  // 카드 칩은 코멘트 전문 대신 '코멘트 있음'만 — 전문이 붙으면 카드가 길어져 비율이 깨진다.
  // 전문은 카드를 눌러 여는 최종 취합 모달 상단 배너(fmModalReview)에서만 노출.
  let cls = '', html = '', htmlFull = '';
  if (st && st.submitted) {
    const hasCmt = !!st.review_comment;
    if (st.status === 'approved') {
      cls = 'approved';
      html = `✅ ${orgLabel('division_head')} 승인 · ${esc((st.reviewed_at || '').slice(0, 16))}` +
             (hasCmt ? ` · 💬 코멘트 있음` : '');
      htmlFull = `✅ ${orgLabel('division_head')} 승인 · ${esc((st.reviewed_at || '').slice(0, 16))}` +
             (hasCmt ? `<br>💬 ${esc(st.review_comment)}` : '');
    } else if (st.status === 'needs_revision') {
      cls = 'revision';
      html = `↩️ ${orgLabel('division_head')} 보완요청` +
             (hasCmt ? ` · 💬 코멘트 있음` : '') + ` — 수정 후 재보고`;
      htmlFull = `↩️ ${orgLabel('division_head')} 보완요청` +
             (hasCmt ? ` — 💬 ${esc(st.review_comment)}` : '') +
             `<br>수정 후 [🚀 재보고] 해주세요`;
    } else {
      cls = 'pending';
      html = htmlFull = `🚀 보고됨 · ${orgLabel('division_head')} 결재 대기 중 (${esc((st.submitted_at || '').slice(0, 16))})`;
    }
  }
  chips.forEach(c => {
    if (!c) return;
    if (!html) { c.style.display = 'none'; c.innerHTML = ''; return; }
    const isModal = c.id === 'fmModalReview';
    // 모달 상단 칩은 전용 레이아웃 클래스(fm-modal-review) 유지 + 코멘트 전문 표시
    c.className = `fm-review-chip ${cls}` + (isModal ? ' fm-modal-review' : '');
    c.innerHTML = isModal ? htmlFull : html;
    c.style.display = '';
  });
}

async function updateFmCta() {
  const el = document.getElementById('fmCtaBanner');
  if (!el) return;
  if (typeof isApprover === 'undefined' || !isApprover) { el.style.display = 'none'; return; }
  el.style.display = '';
  await _fmCheckMyReport();
  const sub = document.getElementById('fmCtaSub');
  const btn = document.getElementById('fmCtaBtn');
  if (_fmMyReport) {
    el.classList.add('ready');
    if (sub) sub.textContent = `✅ 내 보고 작성 완료 — ${orgLabel('member')} 요약과 병합해 최종 보고서를 만들 준비가 됐어요.`;
    if (btn) btn.textContent = '📋 최종 취합본 만들기';
    el.onclick = () => openFinalMerge();   // inline onclick 대체 (상태별 분기)
  } else {
    el.classList.remove('ready');
    if (sub) sub.textContent = '1단계: 먼저 내 주간보고를 작성해주세요. 작성이 끝나면 취합을 안내해드려요.';
    if (btn) btn.textContent = '✍️ 내 보고 쓰고 취합하기';
    // 내 보고가 없으면 팝업 대신 '내 보고 작성' 탭으로 바로 이동 — 팝업 속 가이드보다 직관적
    el.onclick = () => fmGotoMyReport();
  }
  // 결재 상태 칩 (보고 제출 이후에만 표시)
  const wk = _finalMergeWeek();
  if (wk) {
    try {
      const st = await api(`/api/ai/final-report/status?week=${encodeURIComponent(wk)}`);
      _fmRenderReviewChips(st);
      // 보고됨 상태에선 배너 문구도 결재 흐름에 맞게 조정
      if (st.submitted && sub) {
        if (st.status === 'needs_revision') sub.textContent = `↩️ ${orgLabel('division_head')} 보완요청이 도착했어요 — 내용 확인 후 재보고해주세요.`;
        else if (st.status === 'approved')  sub.textContent = `✅ 이번 주 최종 보고가 승인되었습니다.`;
      }
    } catch { _fmRenderReviewChips(null); }
  }
}

function fmGotoMyReport() {
  closeModal('finalMergeModal');
  if (typeof goApproverWrite === 'function') goApproverWrite();
}

async function openFinalMerge() {
  const wk = _finalMergeWeek();
  const wkEl = document.getElementById('finalMergeWeek');
  if (wkEl) wkEl.textContent = wk ? `· ${wk}` : '';
  // 기준 요약 기본값: 프로젝트별 · 섹션형 (상부 보고 표준 양식)
  const sel = document.getElementById('finalBaseType');
  if (sel) sel.value = 'project';
  const st = document.getElementById('finalMergeStatus');
  if (st) st.textContent = '';
  _fmResetProgress();
  fmSetTab('preview');
  openModal('finalMergeModal');
  // 열리자마자 로딩 표시 — 저장본 유무 확인 전까지 가이드/빈 화면을 먼저 보여주지 않음
  const _pv0 = document.getElementById('finalMergePreview');
  const _ed0 = document.getElementById('finalMergeEdit');
  if (_pv0 && _ed0 && !_ed0.value.trim()) {
    _pv0.innerHTML = `<div class="fm-empty"><span class="spin" style="width:22px;height:22px;border-width:2.5px"></span>저장된 취합본 확인 중...</div>`;
  }
  // 본인 보고 상태 확인 후 가이드 갱신 (모달은 먼저 열어 체감 지연 제거)
  await _fmCheckMyReport();
  const genBtn = document.getElementById('finalGenBtn');
  if (genBtn) genBtn.disabled = !_fmMyReport;
  // 저장해둔 최종 취합본 자동 로드 (진행 중인 편집 내용이 없을 때만)
  const ed = document.getElementById('finalMergeEdit');
  if (ed && !ed.value.trim() && wk) {
    try {
      const saved = await api(`/api/ai/summary?week=${wk}&type=${(sel ? sel.value : 'project')}_final`);
      if (saved && saved.summary) {
        ed.value = saved.summary;
        if (st) st.textContent = '💾 저장된 최종 취합본을 불러왔습니다 — [✨ 병합 생성]으로 새로 만들 수도 있어요.';
      }
    } catch {}
  }
  renderFinalPreview();
  _fmRefreshSubmitState();   // 보고 제출 상태 표시 (버튼 라벨·시각)
}

// 기준 요약 변경 시: 그 형식으로 저장해둔 최종본이 있으면 로드 (작성 중 내용은 보존)
async function fmBaseChanged() {
  const ed = document.getElementById('finalMergeEdit');
  if (!ed || ed.value.trim()) return;
  const wk = _finalMergeWeek();
  if (!wk) return;
  const sel = document.getElementById('finalBaseType');
  try {
    const saved = await api(`/api/ai/summary?week=${wk}&type=${sel.value}_final`);
    if (saved && saved.summary) {
      ed.value = saved.summary;
      renderFinalPreview();
      const st = document.getElementById('finalMergeStatus');
      if (st) st.textContent = '💾 저장된 최종 취합본을 불러왔습니다.';
    }
  } catch {}
}

// ── 미리보기(기본) ↔ 직접 수정 (WYSIWYG — 렌더된 화면을 그대로 클릭해 수정) ──
// 마크다운 textarea 는 화면에서 제거하고 숨은 저장소로만 사용. 편집 종료/저장/다운로드 시 html2md 로 역변환 동기화.
function _fmSyncFromPreview() {
  const pv = document.getElementById('finalMergePreview');
  const ed = document.getElementById('finalMergeEdit');
  if (!pv || !ed) return;
  if (pv.querySelector('.fm-empty')) return;   // 가이드/빈 화면은 동기화 대상 아님
  if (!pv.isContentEditable) return;           // 편집 모드였을 때만 역변환
  ed.value = html2md(pv);
}
function fmSetTab(t) {
  const isEdit = t === 'edit';
  const pv = document.getElementById('finalMergePreview');
  const ed = document.getElementById('finalMergeEdit');
  const st = document.getElementById('finalMergeStatus');
  if (!pv || !ed) return;
  if (isEdit && !ed.value.trim()) {
    toast('먼저 [✨ 병합 생성]으로 내용을 만들어주세요.', 'err');
    return;
  }
  if (!isEdit) _fmSyncFromPreview();           // 편집 → 미리보기 복귀: 수정 내용 반영
  pv.contentEditable = isEdit ? 'true' : 'false';
  pv.classList.toggle('editing', isEdit);
  document.getElementById('fmTabPreview')?.classList.toggle('active', !isEdit);
  document.getElementById('fmTabEdit')?.classList.toggle('active', isEdit);
  if (isEdit) {
    if (st) st.textContent = '✏️ 고칠 문구를 본문에서 바로 클릭해 수정하세요 (표 안 글자 포함)';
    pv.focus();
  } else {
    renderFinalPreview();
  }
}

// ── 생성 진행 단계 표시 ──
let _fmTimers = [];
function _fmClearTimers() { _fmTimers.forEach(t => clearInterval(t)); _fmTimers = []; }
function _fmResetProgress() {
  _fmClearTimers();
  document.getElementById('fmProgress')?.classList.remove('show');
  document.querySelectorAll('#fmProgress .fm-step').forEach(el => {
    el.classList.remove('doing', 'done');
    const ic = el.querySelector('.fm-step-ic');
    if (ic) ic.innerHTML = '';
    const tx = el.querySelector('.fm-step-tx');
    if (tx && tx.dataset.base) tx.textContent = tx.dataset.base;
  });
}
function _fmStep(n, state) { // 'doing' | 'done'
  const el = document.querySelector(`#fmProgress .fm-step[data-step="${n}"]`);
  if (!el) return;
  el.classList.remove('doing', 'done');
  el.classList.add(state);
  const ic = el.querySelector('.fm-step-ic');
  if (ic) ic.innerHTML = state === 'done' ? '✓' : '<span class="spin"></span>';
}

async function genFinalMerge() {
  const wk = _finalMergeWeek();
  if (!wk) { toast('주차 정보를 찾을 수 없습니다.', 'err'); return; }
  if (_fmMyReport === false) { toast('먼저 내 주간보고를 작성해주세요.', 'err'); return; }
  const baseType = document.getElementById('finalBaseType').value;
  const btn  = document.getElementById('finalGenBtn');
  const st   = document.getElementById('finalMergeStatus');
  const hero = document.getElementById('fmHero');
  const prog = document.getElementById('fmProgress');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '병합 중...'; }
  if (st) st.textContent = '';
  hero?.classList.add('generating');
  _fmResetProgress();
  prog?.classList.add('show');

  // 단계 연출: 1→2 는 짧게, 3(AI 생성)은 응답까지 경과초 표시 — "멈춘 게 아님"을 보여주는 게 목적
  const t0 = Date.now();
  const step3tx = document.querySelector('#fmProgress .fm-step[data-step="3"] .fm-step-tx');
  if (step3tx && !step3tx.dataset.base) step3tx.dataset.base = step3tx.textContent;
  _fmStep(1, 'doing');
  _fmTimers.push(setTimeout(() => { _fmStep(1, 'done'); _fmStep(2, 'doing'); }, 1000));
  _fmTimers.push(setTimeout(() => {
    _fmStep(2, 'done'); _fmStep(3, 'doing');
    _fmTimers.push(setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      if (step3tx) step3tx.textContent = `${step3tx.dataset.base} (${s}초 · 보통 20~40초)`;
    }, 1000));
  }, 2100));

  try {
    const res = await api('/api/ai/final-summary', {
      method: 'POST',
      body: JSON.stringify({ week_key: wk, base_type: baseType }),
    });
    _fmClearTimers();
    [1, 2, 3].forEach(n => _fmStep(n, 'done'));
    if (step3tx) step3tx.textContent = step3tx.dataset.base.replace('생성 중...', '생성 완료');
    // 새 결과로 교체 — 이전 편집 DOM 이 역변환으로 덮어쓰지 않게 편집 모드 먼저 해제
    const _pv = document.getElementById('finalMergePreview');
    if (_pv) _pv.contentEditable = 'false';
    document.getElementById('finalMergeEdit').value = res.summary || '';
    fmSetTab('preview');
    if (st) st.textContent = '✅ 병합 완료 — 확인 후 저장하세요. 고칠 부분은 [✏️ 직접 수정]';
    setTimeout(() => { document.getElementById('fmProgress')?.classList.remove('show'); }, 1200);
  } catch (e) {
    _fmResetProgress();
    if (st) st.textContent = '';
    toast(e.message || '병합 실패', 'err');
  } finally {
    hero?.classList.remove('generating');
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function renderFinalPreview(fromInput) {
  const pv = document.getElementById('finalMergePreview');
  if (!pv) return;
  // 편집 탭에서 타이핑 중엔 미리보기가 숨겨져 있으므로 매 키입력마다 렌더할 필요 없음
  if (fromInput && pv.style.display === 'none') return;
  const md = document.getElementById('finalMergeEdit').value;
  if (!md.trim()) {
    // 가이드: 본인 보고 미작성 → 작성 유도 / 작성 완료 → 병합 생성 유도
    if (_fmMyReport === false) {
      pv.innerHTML = `<div class="fm-empty" style="min-height:auto"><span class="fm-empty-ic">🧭</span>` +
        `<div class="fm-guide">` +
        `<div class="fm-guide-head">취합 전에 한 가지만!<br>최종 보고서에는 <b>내 주간보고</b>도 함께 들어가요.</div>` +
        `<div class="fm-guide-step now"><span class="fm-guide-num">1</span>` +
          `<span class="fm-guide-tx"><b>내 주간보고 작성</b><small>${olj('member','과')} 동일하게 이번 주 내용을 작성·저장하세요.</small></span>` +
          `<button class="btn-new sm primary" style="flex-shrink:0" onclick="fmGotoMyReport()">✍️ 쓰러 가기</button></div>` +
        `<div class="fm-guide-step wait"><span class="fm-guide-num">2</span>` +
          `<span class="fm-guide-tx"><b>병합 생성</b><small>작성이 끝나면 이 버튼이 활성화됩니다.</small></span></div>` +
        `</div></div>`;
      return;
    }
    if (_fmMyReport === true) {
      pv.innerHTML = `<div class="fm-empty" style="min-height:auto"><span class="fm-empty-ic">🪄</span>` +
        `<div class="fm-guide">` +
        `<div class="fm-guide-step done"><span class="fm-guide-num">✓</span>` +
          `<span class="fm-guide-tx"><b>내 주간보고 작성 완료</b><small>이번 주 보고가 저장되어 있어요.</small></span></div>` +
        `<div class="fm-guide-step now"><span class="fm-guide-num">2</span>` +
          `<span class="fm-guide-tx"><b>병합 생성</b><small>위의 <b>[✨ 병합 생성]</b>을 누르면 ${orgLabel('member')} 요약 + 내 보고가 하나의 보고서로 합쳐집니다.</small></span></div>` +
        `</div></div>`;
      return;
    }
    pv.innerHTML = `<div class="fm-empty"><span class="fm-empty-ic">🪄</span>` +
      `아직 병합 결과가 없어요.<br>위의 <b>[✨ 병합 생성]</b> 을 누르면<br>` +
      `${orgLabel('member')} 요약과 본인 보고가 하나의 문서로 합쳐집니다.</div>`;
    return;
  }
  pv.innerHTML = md2html(md);
}
async function saveFinalMerge() {
  _fmSyncFromPreview();   // WYSIWYG 편집 중이면 최신 수정 내용 반영
  const wk = _finalMergeWeek();
  const baseType = document.getElementById('finalBaseType').value;
  const content = document.getElementById('finalMergeEdit').value;
  if (!content.trim()) { toast('저장할 내용이 없습니다.', 'err'); return; }
  showActionLoader('최종 취합본 저장 중...');
  try {
    await api('/api/ai/summary', {
      method: 'POST',
      body: JSON.stringify({ week_key: wk, summary_content: content, summary_type: `${baseType}_final` }),
    });
    toast('💾 최종 취합본이 저장되었습니다.', 'ok');
  } catch (e) {
    toast('저장 실패: ' + (e.message || e), 'err');
  } finally {
    hideActionLoader();
  }
}
// ── 최종 취합 '보고' — 그룹장(상위조직장)이 열람하는 공식 제출 ──
async function _fmRefreshSubmitState() {
  const el = document.getElementById('fmSubmitState');
  const btn = document.getElementById('fmSubmitBtn');
  const wk = _finalMergeWeek();
  if (!el || !wk) return;
  try {
    const st = await api(`/api/ai/final-report/status?week=${encodeURIComponent(wk)}`);
    _fmRenderReviewChips(st);   // 모달 상단 배너 + 현황/작성 탭 칩 동시 갱신
    if (st.submitted) {
      // 결재 상태별 표시 — 승인/보완요청은 그룹장 코멘트까지 노출
      if (st.status === 'approved') {
        el.innerHTML = `<span style="color:#16a34a;font-weight:700">✅ 승인됨</span> · ${esc((st.reviewed_at || '').slice(0, 16))}` +
          (st.review_comment ? ` · 💬 ${esc(st.review_comment)}` : '');
      } else if (st.status === 'needs_revision') {
        el.innerHTML = `<span style="color:var(--warn,#d97706);font-weight:700">↩️ 보완요청</span>` +
          (st.review_comment ? ` · 💬 ${esc(st.review_comment)}` : '') +
          ` — 수정 후 다시 [🚀 재보고] 해주세요`;
      } else {
        el.textContent = `🚀 보고됨 (결재 대기) · ${(st.submitted_at || '').slice(0, 16)}`;
      }
      if (btn) btn.textContent = '🚀 재보고';
    } else {
      el.textContent = '';
      if (btn) btn.textContent = '🚀 보고';
    }
  } catch { /* 상태 조회 실패는 무시 (버튼 기본 상태 유지) */ }
}

async function submitFinalReport() {
  _fmSyncFromPreview();   // WYSIWYG 편집 중이면 최신 수정 내용 반영
  const wk = _finalMergeWeek();
  const baseType = document.getElementById('finalBaseType').value;
  const content = document.getElementById('finalMergeEdit').value;
  if (!content.trim()) { toast('보고할 내용이 없습니다. 먼저 [✨ 병합 생성]을 해주세요.', 'err'); return; }
  if (!confirm(`${getWeekLabel(wk)} 최종 취합본을 ${orgLabel('division_head')}에게 보고합니다.\n(이미 보고한 주차면 새 내용으로 덮어씁니다)\n계속하시겠습니까?`)) return;
  showActionLoader('최종 보고 제출 중...');
  try {
    // 보고 = 저장 + 제출 (저장본과 제출본을 함께 최신화)
    await api('/api/ai/summary', {
      method: 'POST',
      body: JSON.stringify({ week_key: wk, summary_content: content, summary_type: `${baseType}_final` }),
    });
    const r = await api('/api/ai/final-report/submit', {
      method: 'POST',
      body: JSON.stringify({ week_key: wk, content, base_type: baseType }),
    });
    toast(`🚀 최종 보고가 제출되었습니다 (${(r.submitted_at || '').slice(0, 16)})`, 'ok');
    _fmRefreshSubmitState();
  } catch (e) {
    toast('보고 실패: ' + (e.message || e), 'err');
  } finally {
    hideActionLoader();
  }
}

function downloadFinalMerge() {
  _fmSyncFromPreview();   // WYSIWYG 편집 중이면 최신 수정 내용 반영
  const content = document.getElementById('finalMergeEdit').value;
  if (!content.trim()) { toast('다운로드할 내용이 없습니다.', 'err'); return; }
  const wk = _finalMergeWeek() || 'summary';
  const filename = `주간보고_최종취합_${wk}.md`;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast(`📥 ${filename} 다운로드`, 'ok');
}
