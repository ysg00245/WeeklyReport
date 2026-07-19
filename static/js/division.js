// ═══════════════════════════════════════════════════════════
//  그룹장(상위조직장) 콘솔 — 유닛장들이 '보고'한 최종 취합본 열람
//  진입: PIN 로그인 이름이 divisions.head_name 과 일치 (auth.js 라우팅)
// ═══════════════════════════════════════════════════════════
let _dhData = null;          // 마지막 조회 결과 (divisions[])
let _dhViewing = null;       // 열람 중인 보고 {team_name, content, week}

function _dhPopulateWeekSel() {
  const sel = document.getElementById('dhWeekSel');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '';
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

async function gotoDivisionHead() {
  const t = document.getElementById('dhTitle');
  const s = document.getElementById('dhSubtitle');
  if (t) t.textContent = `${orgLabel('division')} 보고 현황`;
  if (s) s.textContent = `${orgLabel('team')}별 최종 보고 열람`;
  // 그룹장도 구성원 — PIN 세션이면 본인 주간보고 작성 가능
  const wbtn = document.getElementById('dhMyWriteBtn');
  if (wbtn) wbtn.style.display = (typeof user !== 'undefined' && user) ? '' : 'none';
  // 그룹장 + 유닛장 겸직(예: 그룹장이면서 타 유닛의 유닛장) — 현재 유닛의 결재권자 콘솔로 이동 버튼
  const ubtn = document.getElementById('dhMyUnitBtn');
  if (ubtn) ubtn.style.display =
    (typeof user !== 'undefined' && user && typeof memberIsApprover === 'function' && memberIsApprover(user.name)) ? '' : 'none';
  showPage('pgDivision');
  _dhPopulateWeekSel();
  await renderDivisionDash();
}

async function renderDivisionDash() {
  const wk = document.getElementById('dhWeekSel')?.value;
  const box = document.getElementById('dhContent');
  if (!wk || !box) return;
  box.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px"><span class="spin" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>보고 현황을 불러오는 중...</div>`;
  let data;
  try {
    data = await api(`/api/ai/division-reports?week=${encodeURIComponent(wk)}`);
  } catch (e) {
    box.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);font-size:13px">조회 실패: ${esc(e.message || '')}</div>`;
    return;
  }
  _dhData = data;
  const divs = data.divisions || [];
  if (!divs.length) {
    box.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text3);font-size:13px">담당 ${olj('division','이')} 없습니다.</div>`;
    return;
  }
  let html = '';
  for (const d of divs) {
    const total = d.teams.length;
    const done = d.teams.filter(t => t.submitted).length;
    html += `<div class="card" style="margin-bottom:16px"><div class="card-head">` +
      `<div><div class="card-title">🏢 ${esc(d.division_name)}</div>` +
      `<div class="card-sub">보고 제출 ${done} / ${total} ${orgLabel('team')}</div></div></div>` +
      `<div class="submit-list">`;
    for (const t of d.teams) {
      // 결재 상태 배지: 미보고 / ⏳ 결재 대기 / ✅ 승인 / ↩️ 보완요청
      let badge;
      if (!t.submitted)                          badge = `<span class="badge-new">미보고</span>`;
      else if (t.status === 'approved')          badge = `<span class="badge-new success">✅ 승인</span>`;
      else if (t.status === 'needs_revision')    badge = `<span class="badge-new warning">↩️ 보완요청</span>`;
      else                                       badge = `<span class="badge-new" style="color:var(--brand-600);border-color:color-mix(in oklab, var(--brand-500) 35%, transparent)">⏳ 결재 대기</span>`;
      const meta = t.submitted
        ? `${esc(t.submitted_by || t.leader_name || '')} · ${esc((t.submitted_at || '').slice(0, 16))}` +
          (t.status === 'needs_revision' && t.review_comment ? ` · <span style="color:var(--warn,#d97706)">"${esc(t.review_comment.slice(0, 30))}${t.review_comment.length > 30 ? '…' : ''}"</span>` : '')
        : (t.leader_name ? `${orgLabel('leader')}: ${esc(t.leader_name)}` : `${orgLabel('leader')} 미지정`);
      html += `<div class="row-flex" style="justify-content:space-between;gap:10px;padding:13px 20px;border-top:1px solid var(--line);${t.submitted ? 'cursor:pointer' : 'opacity:.75'}"` +
        (t.submitted ? ` onclick="dhOpenReport(${t.team_id})"` : '') + `>` +
        `<div style="min-width:0"><div style="font-size:14px;font-weight:700;color:var(--text)">${esc(t.team_name)}</div>` +
        `<div style="font-size:12px;color:var(--text2);margin-top:2px">${meta}</div></div>` +
        `<div class="row-flex" style="gap:8px;flex-shrink:0">${badge}` +
        (t.submitted ? `<span style="font-size:12px;color:var(--brand-600);font-weight:600">열람 →</span>` : '') +
        `</div></div>`;
    }
    html += `</div></div>`;
  }
  box.innerHTML = html;
}

function dhOpenReport(teamId) {
  if (!_dhData) return;
  let team = null;
  for (const d of _dhData.divisions) {
    const t = d.teams.find(x => x.team_id === teamId);
    if (t) { team = t; break; }
  }
  if (!team || !team.submitted) return;
  _dhViewing = { team_id: team.team_id, team_name: team.team_name, content: team.content, week: _dhData.week_key, status: team.status };
  const titleEl = document.getElementById('dhReportTitle');
  const metaEl = document.getElementById('dhReportMeta');
  const bodyEl = document.getElementById('dhReportBody');
  if (titleEl) titleEl.textContent = `${team.team_name} 최종 보고`;
  if (metaEl) metaEl.textContent = `${getWeekLabel(_dhData.week_key)} · ${team.submitted_by || ''} · ${(team.submitted_at || '').slice(0, 16)}`;
  if (bodyEl) bodyEl.innerHTML = md2html(team.content);
  // 결재 상태 표시 + 코멘트 세팅 (이미 결재한 보고면 기존 코멘트를 채워 수정하기 쉽게)
  const stEl = document.getElementById('dhReviewState');
  const cmEl = document.getElementById('dhReviewComment');
  const reviewed = team.status === 'approved' || team.status === 'needs_revision';
  if (cmEl) cmEl.value = reviewed ? (team.review_comment || '') : '';
  // 이미 결재된 보고 → 같은 액션 버튼은 '수정' 라벨로 (승인됨 상태에서 또 '승인'이면 혼란)
  const apBtn = document.getElementById('dhBtnApprove');
  const rvBtn = document.getElementById('dhBtnRevise');
  if (apBtn) apBtn.textContent = team.status === 'approved' ? '✏️ 승인 수정' : '✅ 승인';
  if (rvBtn) rvBtn.textContent = team.status === 'needs_revision' ? '✏️ 보완요청 수정' : '↩️ 보완요청';
  if (stEl) {
    if (team.status === 'approved') {
      stEl.style.display = '';
      stEl.style.background = 'color-mix(in oklab, #16a34a 10%, var(--surface))';
      stEl.style.color = 'var(--text)';
      stEl.innerHTML = `✅ <b>승인됨</b> · ${esc(team.reviewed_by || '')} · ${esc((team.reviewed_at || '').slice(0, 16))}` +
        (team.review_comment ? `<br>💬 ${esc(team.review_comment)}` : '');
    } else if (team.status === 'needs_revision') {
      stEl.style.display = '';
      stEl.style.background = 'color-mix(in oklab, #d97706 10%, var(--surface))';
      stEl.style.color = 'var(--text)';
      stEl.innerHTML = `↩️ <b>보완요청됨</b> · ${esc(team.reviewed_by || '')} · ${esc((team.reviewed_at || '').slice(0, 16))}` +
        (team.review_comment ? `<br>💬 ${esc(team.review_comment)}` : '');
    } else {
      stEl.style.display = 'none';
      stEl.innerHTML = '';
    }
  }
  openModal('dhReportModal');
}

// 결재 실행 — approve(승인, 코멘트 선택) / revise(보완요청, 코멘트 필수 → WS·푸시로 유닛장 통지)
async function dhReview(action) {
  if (!_dhViewing) return;
  const comment = (document.getElementById('dhReviewComment')?.value || '').trim();
  if (action === 'revise' && !comment) {
    toast('보완요청 시 코멘트를 입력해주세요.', 'err');
    document.getElementById('dhReviewComment')?.focus();
    return;
  }
  // 같은 상태로 다시 결재하면 '수정' — 라벨·확인문구·토스트 전부 구분
  const isEdit = (action === 'approve' && _dhViewing.status === 'approved')
              || (action === 'revise'  && _dhViewing.status === 'needs_revision');
  const label = (action === 'approve' ? '승인' : '보완요청') + (isEdit ? ' 수정' : '');
  if (!confirm(isEdit
    ? `${_dhViewing.team_name}의 ${getWeekLabel(_dhViewing.week)} 결재 내용(코멘트)을 수정합니다.\n계속하시겠습니까?`
    : `${_dhViewing.team_name}의 ${getWeekLabel(_dhViewing.week)} 최종 보고를 [${label}] 처리합니다.\n계속하시겠습니까?`)) return;
  showActionLoader(`${label} 처리 중...`);
  try {
    await api('/api/ai/final-report/review', {
      method: 'POST',
      body: JSON.stringify({ team_id: _dhViewing.team_id, week_key: _dhViewing.week, action, comment }),
    });
    toast(isEdit
      ? `✏️ ${label} 완료 — 변경된 코멘트가 ${orgLabel('leader')}에게 전달되었습니다.`
      : (action === 'approve' ? `✅ 승인 완료 — ${orgLabel('leader')}에게 알림이 전송되었습니다.` : `↩️ 보완요청 완료 — ${orgLabel('leader')}에게 알림이 전송되었습니다.`), 'ok');
    closeModal('dhReportModal');
    renderDivisionDash();   // 목록 배지 갱신
  } catch (e) {
    toast(`${label} 실패: ` + (e.message || e), 'err');
  } finally {
    hideActionLoader();
  }
}

async function dhCopyReport() {
  if (!_dhViewing) return;
  try {
    await navigator.clipboard.writeText(_dhViewing.content);
    toast('📋 보고 내용이 복사되었습니다.', 'ok');
  } catch { toast('복사에 실패했습니다.', 'err'); }
}

function dhDownloadReport() {
  if (!_dhViewing) return;
  const filename = `최종보고_${_dhViewing.team_name}_${_dhViewing.week}.md`;
  const blob = new Blob([_dhViewing.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast(`📥 ${filename} 다운로드`, 'ok');
}
