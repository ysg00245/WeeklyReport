// ── 팀원 순서 조절 (Drag & Drop) ──
let draggedIdx = null;
function rowDragStart(e, idx) {
  draggedIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
}
function rowDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
async function rowDrop(e, targetIdx) {
  e.preventDefault();
  if (draggedIdx === null || draggedIdx === targetIdx) return;

  const movedItem = members.splice(draggedIdx, 1)[0];
  members.splice(targetIdx, 0, movedItem);

  showActionLoader('순서 저장 중...');
  try {
    const names = members.map(m => m.name);
    await api('/api/members/reorder/all', {
      method: 'PUT',
      body: JSON.stringify({ names })
    });
    renderRoleTable();
    populateLoginSel();
    renderPinTable(); // 순서 변경 사항을 PIN 관리 탭에도 즉시 반영
    renderDash();
    toast('✅ 순서가 변경되어 저장되었습니다', 'ok');
  } catch (err) {
    toast('순서 저장 실패: ' + err.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  팀원 관리
// ═══════════════════════════════════════
async function addMember() {
  const name = document.getElementById('newMemberName').value.trim();
  const role = document.getElementById('newMemberRole').value;
  const position = document.getElementById('newMemberPosition').value;
  const project = document.getElementById('newMemberProject').value;
  const sub_role = document.getElementById('newMemberSubRole').value;
  if (!name) { toast('이름을 입력해주세요', 'err'); return; }
  showActionLoader(`${orgLabel('member')} 추가 중...`);
  try {
    await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({ name, role, position, project, sub_role }),
    });
    document.getElementById('newMemberName').value = '';
    document.getElementById('newMemberRole').value = 'etc';
    document.getElementById('newMemberPosition').value = '';
    document.getElementById('newMemberProject').value = '';
    document.getElementById('newMemberSubRole').value = '';
    document.getElementById('newMemberSubRole').disabled = true;
    await loadMembers();
    renderRoleTable();
    renderPinTable();
    populateLoginSel();
    renderDash();
    toast(`✓ ${name}님이 추가되었습니다`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

async function deleteMember(name) {
  if (!confirm(`${name}님을 삭제하시겠습니까?\n현재 주차 보고는 삭제되고, 과거 이력은 보존됩니다.`)) return;
  showActionLoader(`${orgLabel('member')} 삭제 중...`);
  try {
    await api(`/api/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadMembers();
    renderRoleTable();
    renderPinTable();
    populateLoginSel();
    renderDash();
    toast(`✓ ${name}님이 삭제되었습니다 (과거 이력 보존)`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

function renderRoleTable() {
  const posOpts = ['','사원','대리','과장','차장','부장'];
  const projOpts = [''].concat(globalSettings.projects_schema || []);
  const pRoleOpts = globalSettings.project_roles_schema || [];
  
  document.getElementById('roleTable').innerHTML =
    `<tr>
      <th style="width:24px"></th>
      <th style="white-space:nowrap; width:1%">이름</th>
      <th style="white-space:nowrap">상태</th>
      <th style="white-space:nowrap; width:1%">역할</th>
      <th style="white-space:nowrap; width:1%">직급</th>
      <th style="white-space:nowrap; width:1%">투입 프로젝트</th>
      <th style="white-space:nowrap; width:1%">프로젝트 ROLE</th>
      <th style="white-space:nowrap; width:1%; text-align:center !important" title="체크 해제 시 미제출/제출률 집계에서 제외 (명단·로그인엔 그대로 노출)">집계</th>
      <th style="white-space:nowrap; width:1%; text-align:center !important">관리</th>
    </tr>` +
    members.map((m, idx) => {
      // 팀장 / 주보관리자(정·부) 배지 — 서버에서 boolean 으로 내려옴
      const leaderBadge = m.is_leader
        ? `<span style="font-size:10px;color:#fff;background:linear-gradient(135deg,var(--brand-500),var(--brand-700));padding:2px 7px;border-radius:999px;font-weight:700;white-space:nowrap">👑 ${orgLabel('leader')}</span>` : '';
      const raPrimary = m.is_report_admin_primary
        ? '<span style="font-size:10px;color:var(--warning);background:color-mix(in oklab, var(--warning) 14%, transparent);padding:2px 7px;border-radius:999px;font-weight:600;white-space:nowrap">📋 주보(정)</span>' : '';
      const raSecondary = m.is_report_admin_secondary
        ? '<span style="font-size:10px;color:var(--warning);background:color-mix(in oklab, var(--warning) 8%, transparent);padding:2px 7px;border-radius:999px;white-space:nowrap">📋 주보(부)</span>' : '';
      // 모든 td 에 vertical-align:middle 명시 — 배지 wrap 으로 행 높이 늘어나도 다른 셀(이름/select)이 가운데 정렬
      return `<tr draggable="true" ondragstart="rowDragStart(event, ${idx})" ondragover="rowDragOver(event)" ondrop="rowDrop(event, ${idx})" style="cursor:move;vertical-align:middle">
      <td style="color:var(--text3); padding:8px 4px; text-align:center; user-select:none; vertical-align:middle">⋮⋮</td>
      <td style="font-weight:600; white-space:nowrap; padding:8px 6px; vertical-align:middle">${m.name}</td>
      <td style="min-width:220px;white-space:normal;padding:8px 6px;vertical-align:middle"><div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;row-gap:4px">${roleBadge(m.role)}${positionBadge(m.position)}${projectBadge(m.project)}${leaderBadge}${raPrimary}${raSecondary}</div></td>
      <td style="white-space:nowrap"><select id="role_${m.name}" onchange="handleRoleChange('${m.name}')" style="font-size:12px;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;">
        <option value="etc" ${m.role==='etc'?'selected':''}>기타</option>
        <option value="dev" ${m.role==='dev'?'selected':''}>개발</option>
        <option value="ops" ${m.role==='ops'?'selected':''}>운영</option>
      </select></td>
      <td style="white-space:nowrap"><select id="pos_${m.name}" style="font-size:12px;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;">
        ${posOpts.map(p => `<option value="${esc(p)}" ${m.position===p?'selected':''}>${esc(p)||'없음'}</option>`).join('')}
      </select></td>
      <td style="white-space:nowrap"><select id="proj_${m.name}" onchange="handleProjChange('${m.name}')" style="font-size:12px;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;">
        ${projOpts.map(p => `<option value="${esc(p)}" ${m.project===p?'selected':''}>${esc(p)||'선택 안함'}</option>`).join('')}
      </select></td>
      <td style="white-space:nowrap"><select id="sub_role_${m.name}" style="font-size:12px;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;" ${!m.project?'disabled':''}>
        <option value="">${m.project?'선택':'---'}</option>
        ${pRoleOpts.map(pr => `<option value="${esc(pr)}" ${m.sub_role===pr?'selected':''}>${esc(pr)}</option>`).join('')}
      </select></td>
      <td style="text-align:center; white-space:nowrap; vertical-align:middle"><input type="checkbox" ${m.is_report_target !== false ? 'checked' : ''} onchange="toggleReportTarget('${m.name}', this.checked)" title="주간보고 집계 대상 (해제 시 미제출/제출률 집계에서 제외)" style="width:18px;height:18px;cursor:pointer"></td>
      <td style="text-align:center; white-space:nowrap"><button class="btn btn-d btn-sm" style="white-space:nowrap;min-width:44px" onclick="deleteMember('${m.name}')">삭제</button></td>
    </tr>`;
    }).join('');
}

function handleProjChange(name) {
  const proj = document.getElementById(`proj_${name}`).value;
  const subRole = document.getElementById(`sub_role_${name}`);
  if (proj) {
    subRole.disabled = false;
    subRole.options[0].text = '선택';
  } else {
    subRole.disabled = true;
    subRole.value = '';
    subRole.options[0].text = '---';
  }
}

function updateAddMemberPRoles() {
  const proj = document.getElementById('newMemberProject').value;
  const sub = document.getElementById('newMemberSubRole');
  if (proj) {
    sub.disabled = false;
    sub.options[0].text = '선택';
    const opts = ['<option value="">선택</option>'].concat((globalSettings.project_roles_schema || []).map(pr => `<option value="${esc(pr)}">${esc(pr)}</option>`));
    sub.innerHTML = opts.join('');
  } else {
    sub.disabled = true;
    sub.innerHTML = '<option value="">---</option>';
  }
}

function handleRoleChange(name) {
  // 메인 역할 변경 시 추가 로직 필요 시 작성
}

// 주간보고 집계 대상 토글 (팀 관리자). 명단/로그인 노출(is_visible)과 별개 — 미제출/제출률 집계 포함 여부만 변경.
async function toggleReportTarget(name, isTarget) {
  showActionLoader('집계 대상 변경 중...');
  try {
    await api(`/api/members/${encodeURIComponent(name)}/report-target`, {
      method: 'PUT',
      body: JSON.stringify({ is_report_target: !!isTarget }),
    });
    // 로컬 상태 즉시 반영 → 현황 집계 재계산
    const m = members.find(x => x.name === name);
    if (m) m.is_report_target = !!isTarget;
    toast(`${name}: 집계 ${isTarget ? '대상' : '제외'}`, 'ok');
    if (typeof renderDash === 'function') renderDash();
  } catch (e) {
    toast('집계 대상 변경 실패: ' + e.message, 'err');
    // 실패 시 체크박스 원복
    if (typeof renderRoleTable === 'function') renderRoleTable();
  } finally {
    hideActionLoader();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 초기화 불필요 (applySettingsToUI에서 처리)
});

async function saveRoles() {
  const updates = [];
  for (const m of members) {
    const newRole = document.getElementById(`role_${m.name}`).value;
    const newSubRole = document.getElementById(`sub_role_${m.name}`).value;
    const newPos = document.getElementById(`pos_${m.name}`).value;
    const newProj = document.getElementById(`proj_${m.name}`).value;

    if (newRole !== m.role || newSubRole !== m.sub_role || newPos !== m.position || newProj !== m.project) {
      updates.push({
        name: m.name,
        update: { role: newRole, sub_role: newSubRole, position: newPos, project: newProj }
      });
    }
  }

  if (updates.length === 0) {
    toast('변경사항이 없습니다.', 'info');
    return;
  }

  showActionLoader(`${updates.length}명 정보 저장 중...`);
  try {
    await api('/api/members/batch', {
      method: 'PUT',
      body: JSON.stringify({ items: updates }),
    });

    await loadMembers();
    renderRoleTable();
    populateLoginSel();
    renderPinTable();
    const msg = updates.length === 1
      ? `✓ ${updates[0].name}님의 정보가 수정되었습니다`
      : `✓ ${updates.length}명의 정보가 일괄 저장되었습니다`;
    toast(msg, 'ok');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    hideActionLoader();
  }
}

// ═══════════════════════════════════════
//  PIN 관리
// ═══════════════════════════════════════
function renderPinTable() {
  // PIN 상태를 서버에서 알 수 없으므로 (해시만 저장),
  // 단순히 초기화 버튼만 제공
  document.getElementById('pinTable').innerHTML =
    `<tr>
      <th style="white-space:nowrap; width:1%">이름</th>
      <th style="white-space:nowrap; width:1%">PIN 상태</th>
      <th style="white-space:nowrap; width:1%">등록일</th>
      <th style="white-space:nowrap; text-align:right">관리</th>
    </tr>` +
    members.map(m => {
      const setAt = (m.pin_set_at || '').slice(0, 10);
      return `<tr>
      <td style="font-weight:600; white-space:nowrap">${m.name}</td>
      <td style="white-space:nowrap"><span class="pin-status" id="pinSt_${m.name}">확인 중...</span></td>
      <td style="white-space:nowrap; font-size:12px; color:var(--text2)">${m.has_pin ? (setAt || '-') : '-'}</td>
      <td style="text-align:right; white-space:nowrap"><button class="btn btn-d btn-sm" style="white-space:nowrap;min-width:52px" onclick="resetPin('${m.name}')">초기화</button></td>
    </tr>`;
    }).join('');

  // PIN 등록 상태 비동기 확인 (로그인 시도 없이는 알 수 없으므로 표시만)
  // 간단한 방법: 서버에 PIN 존재 여부 확인 API가 없으므로 일단 표시
  members.forEach(m => {
    const el = document.getElementById(`pinSt_${m.name}`);
    if (el) {
      if (m.has_pin) {
        el.textContent = '●●●● (등록됨)';
        el.className = 'pin-status set';
      } else {
        el.textContent = '○ ○ ○ ○ (미등록)';
        el.className = 'pin-status';
        el.style.color = 'var(--text3)';
      }
    }
  });
}

async function resetPin(name) {
  if (!confirm(`${name}님의 PIN을 초기화하시겠습니까?\n다음 로그인 시 새 PIN을 등록해야 합니다.`)) return;
  showActionLoader('PIN 초기화 중...');
  try {
    await api('/api/auth/reset-pin', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    toast(`${name}님 PIN이 초기화되었습니다`, 'ok');
    // 화면 즉시 반영: 멤버 목록 다시 불러서 PIN 상태/등록일 갱신
    await loadMembers();
    renderPinTable();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    hideActionLoader();
  }
}
