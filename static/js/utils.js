// ═══════════════════════════════════════
//  주차 계산
// ═══════════════════════════════════════
const CW = getWeekKey();

function getWeekKey(date = new Date()) {
  const d = new Date(date); d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const ys = new Date(d.getFullYear(), 0, 1);
  const wn = Math.ceil((((d - ys) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(wn).padStart(2,'0')}`;
}

function weekMonday(key) {
  const [year, w] = key.split('-W');
  const wn = parseInt(w);
  const jan4 = new Date(year, 0, 4);
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1 + (wn - 1) * 7);
  return mon;
}

function yearWeekLabel(key) {
  const [year, w] = key.split('-W');
  const yy = year.substring(2, 4);
  return `${yy}년 ${parseInt(w)}주차`;
}

function monthWeekLabel(key) {
  const mon = weekMonday(key);
  const m = mon.getMonth() + 1;
  const yy = mon.getFullYear().toString().substring(2, 4);
  const firstDay = new Date(mon.getFullYear(), mon.getMonth(), 1);
  const firstMon = new Date(firstDay);
  const dow = firstDay.getDay();
  firstMon.setDate(firstDay.getDate() + (dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow));
  const diff = Math.round((mon - firstMon) / (7 * 86400000));
  const mw = diff + 1;
  return `${yy}년 ${m}월 ${mw}주차`;
}

function weekRange(key) {
  const mon = weekMonday(key);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const fmt = d => `${d.getMonth()+1}/${d.getDate()}`;
  return `${fmt(mon)} ~ ${fmt(fri)}`;
}

function getWeekLabel(key) {
  return weekMode === 0 ? yearWeekLabel(key) : monthWeekLabel(key);
}

function toggleWeekMode() {
  weekMode = weekMode === 0 ? 1 : 0;
  localStorage.setItem('wr_wmode', weekMode);
  updateWeekChip();
  if (user) {
    updateBanner();
    renderWriteForm();
    populateUserWeekSel();
  }
  populateAdminWeekSel();
}

function updateWeekChip() {
  const titleEl = document.getElementById('chipTitle');
  if (titleEl) titleEl.textContent = getWeekLabel(CW);
  const rangeEl = document.getElementById('chipRange');
  if (rangeEl) rangeEl.innerHTML = `${weekRange(CW)} <span class="hint">(클릭: 표시 전환)</span>`;
}

//  테마
// ═══════════════════════════════════════
const _SVG_MOON = '<path d="M21 13A9 9 0 0 1 11 3a7 7 0 1 0 10 10z"/>';
const _SVG_SUN  = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

function applyThemeIcon(theme) {
  const ico = document.getElementById('themeIcon');
  if (!ico) return;
  // light 모드일 땐 다크로 갈 버튼=달, dark 모드일 땐 라이트로 갈 버튼=해
  ico.innerHTML = theme === 'dark' ? _SVG_SUN : _SVG_MOON;
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  applyThemeIcon(next);
  localStorage.setItem('wr_theme', next);
}

// ═══════════════════════════════════════
//  마크다운 → HTML
// ═══════════════════════════════════════
function md2html(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let inUl = false, inOl = false, inTable = false;
  const closeAll = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
    if (inTable) { html += '</tbody></table></div>'; inTable = false; }
  };
  lines.forEach(raw => {
    const line = raw.trimEnd();
    if (!line.trim()) { closeAll(); return; }
    
    // 테이블 처리
    if (/^\|/.test(line.trim()) && line.trim().endsWith('|')) {
      const cells = line.trim().split('|').filter((c, i, a) => i > 0 && i < a.length - 1);
      if (/^[:\-\s|]+$/.test(line.trim())) return; // 구분선 무시
      
      if (!inTable) {
        closeAll();
        html += '<div class="ai-table-wrap"><table><thead><tr>' + 
                cells.map(c => `<th>${inline(c.trim())}</th>`).join('') + 
                '</tr></thead><tbody>';
        inTable = true;
      } else {
        html += '<tr>' + cells.map(c => `<td>${_cellBullets(c.trim())}</td>`).join('') + '</tr>';
      }
      return;
    }

    if (/^### /.test(line)) { closeAll(); html += `<h3>${inline(line.slice(4))}</h3>`; return; }
    if (/^## /.test(line)) { closeAll(); html += `<h2>${inline(line.slice(3))}</h2>`; return; }
    if (/^# /.test(line)) { closeAll(); html += `<h1>${inline(line.slice(2))}</h1>`; return; }
    if (/^---+$/.test(line.trim())) { closeAll(); html += '<hr>'; return; }
    if (/^> /.test(line)) { closeAll(); html += `<blockquote>${inline(line.slice(2))}</blockquote>`; return; }
    // ⚠️ 이슈 라인 — 경고 칩 스타일 (AI 프로젝트별 요약의 이슈 하이라이트)
    if (/^⚠️?\s/.test(line)) { closeAll(); html += `<p class="ai-issue-line">${inline(line)}</p>`; return; }
    if (/^[-*] /.test(line)) {
      if (inOl) { html += '</ol>'; inOl = false; }
      if (!inUl) { closeAll(); html += '<ul>'; inUl = true; }
      html += `<li>${inline(line.slice(2))}</li>`; return;
    }
    if (/^\d+\. /.test(line)) {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (!inOl) { closeAll(); html += '<ol>'; inOl = true; }
      html += `<li>${inline(line.replace(/^\d+\. /,''))}</li>`; return;
    }
    closeAll();
    html += `<p>${inline(line)}</p>`;
  });
  closeAll();
  return html;
}
function inline(s) {
  return s
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/&lt;br\s*\/?&gt;/gi,'<br>')   // 표 셀 내부 줄바꿈용 <br> 만 허용 (그 외 태그는 계속 이스케이프)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/`(.+?)`/g,'<code>$1</code>');
}
// 표 셀: <br> 로 나뉜 bullet 들을 각각 블록(.ai-cl)으로 감싸 '내어쓰기(hanging indent)' 적용.
// → 한 bullet 이 다음 줄로 넘어가도 텍스트가 • 아래로 들여써져 "윗줄의 연속"임이 명확해지고, bullet 사이 간격도 생김.
// '• ' 없이 시작하는 줄 = 직전 bullet 의 '연속 줄'(.ai-cl-cont) — 텍스트 열에 맞춰 들여쓰고 간격을 좁혀 이어짐을 표현.
function _cellBullets(c) {
  const h = inline(c);
  if (!/<br>/i.test(h)) return h;
  return h.split(/<br>/i).map(s => {
    const t = s.trim();
    const cont = !t.startsWith('•');
    return `<div class="ai-cl${cont ? ' ai-cl-cont' : ''}">${t}</div>`;
  }).join('');
}

// ═══════════════════════════════════════
//  HTML → 마크다운 (md2html 의 역변환 — 렌더 화면 직접 수정(WYSIWYG) 저장용)
//  md2html 이 만드는 구조(h1~h3/hr/blockquote/ai-issue-line/ul/ol/table/ai-cl)만 지원.
// ═══════════════════════════════════════
function html2md(root) {
  const inlineMd = (el) => {
    let out = '';
    el.childNodes.forEach(n => {
      if (n.nodeType === 3) { out += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const t = n.nodeName;
      if (t === 'BR') out += '<br>';
      else if (t === 'STRONG' || t === 'B') out += `**${inlineMd(n)}**`;
      else if (t === 'CODE') out += '`' + inlineMd(n) + '`';
      else out += inlineMd(n);   // span/font 등 편집기가 끼워넣는 태그는 텍스트만
    });
    return out;
  };
  // 표 셀: .ai-cl 블록들 → <br> 연결 (bullet 줄바꿈 복원)
  const cellMd = (td) => {
    const cls = td.querySelectorAll(':scope > div.ai-cl');
    if (cls.length) return Array.from(cls).map(d => inlineMd(d).trim()).join('<br>');
    return inlineMd(td).trim().replace(/\n+/g, ' ');
  };
  let md = '';
  root.childNodes.forEach(node => {
    if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) md += t + '\n\n'; return; }
    if (node.nodeType !== 1) return;
    const tag = node.nodeName;
    if (tag === 'H1') md += `# ${inlineMd(node).trim()}\n\n`;
    else if (tag === 'H2') md += `## ${inlineMd(node).trim()}\n\n`;
    else if (tag === 'H3') md += `### ${inlineMd(node).trim()}\n\n`;
    else if (tag === 'HR') md += `---\n\n`;
    else if (tag === 'BLOCKQUOTE') md += `> ${inlineMd(node).trim()}\n\n`;
    else if (tag === 'UL') { node.querySelectorAll(':scope > li').forEach(li => { md += `- ${inlineMd(li).trim()}\n`; }); md += '\n'; }
    else if (tag === 'OL') { let i = 1; node.querySelectorAll(':scope > li').forEach(li => { md += `${i++}. ${inlineMd(li).trim()}\n`; }); md += '\n'; }
    else if (tag === 'DIV' && node.classList.contains('ai-table-wrap')) {
      const table = node.querySelector('table');
      if (!table) return;
      const ths = Array.from(table.querySelectorAll('thead th')).map(th => inlineMd(th).trim());
      if (ths.length) md += `| ${ths.join(' | ')} |\n|${ths.map(() => '---').join('|')}|\n`;
      table.querySelectorAll('tbody tr').forEach(tr => {
        const tds = Array.from(tr.querySelectorAll(':scope > td')).map(cellMd);
        md += `| ${tds.join(' | ')} |\n`;
      });
      md += '\n';
    }
    else md += `${inlineMd(node).trim()}\n\n`;   // p (⚠️ ai-issue-line 포함 — 텍스트가 이미 ⚠️ 로 시작)
  });
  return md.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ═══════════════════════════════════════
//  유틸
// ═══════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  localStorage.setItem('wr_cur_page', id);
  // 로그인 페이지로 이동할 때: 1단계로 복귀 + PIN 초기화
  if (id === 'pgLogin') {
    if (typeof loginGoBack === 'function') loginGoBack();
    else if (typeof clearPinInput === 'function') clearPinInput();
    // 그룹 직속 소속(divhq-*)이 '1명뿐'일 때만 구성원 선택 단계를 건너뛰고 그 사람 PIN 으로 직행한다.
    // (1인짜리 선택 화면은 무의미 — picker 에서 이미 그 사람을 고른 것과 같으므로)
    // 직속 인원이 2명 이상(그룹장 + 그룹 직속 대기 인원 등)이면 일반 유닛과 동일하게 구성원 선택 화면을 노출.
    // 중앙 훅: showPage 가 pgLogin 노출의 단일 관문이라 로그아웃·직접 URL·세션 만료 등 모든 경로를 커버.
    try {
      const _slug = (typeof getTeamSlug === 'function') ? getTeamSlug() : '';
      const _visible = (typeof members !== 'undefined' ? (members || []) : [])
        .filter(m => m.is_visible !== false);
      if (_slug.startsWith('divhq-') && _visible.length === 1 && typeof selectLoginMember === 'function') {
        selectLoginMember(_visible[0].name);
      }
    } catch (_) {}
  }
  // 팀 선택 페이지: 유저칩(로그인) 숨김 + 관리자 진입 버튼만 노출
  // (picker 자체에 자체 헤더가 있고 일반 팀원 로그인은 팀 카드 클릭 후이므로 user-chip 은 의미 없음)
  const userWrap = document.getElementById('userWrap');
  const adminBtn = document.getElementById('adminBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  if (id === 'pgTeamSelect') {
    if (userWrap)  userWrap.style.display = 'none';
    if (adminBtn)  adminBtn.style.display = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}
// ── Modal open/close + Android back 처리 ───────────────────
// PWA standalone 환경에서 Android 시스템 뒤로가기는 기본적으로 앱 종료로 이어짐.
// 모달이 열려 있을 땐 뒤로가기 = 모달 닫기 로 동작하도록 history.state 활용.
//   openModal: history.pushState({modalId: id}, '', '') 로 가상 히스토리 추가
//   popstate: 그 state 의 modalId 가 현재 열려있는 모달이면 close 후 흐름 흡수
const _modalStack = [];   // 현재 열린 모달 id 스택 (중첩 모달 대응)

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  // 모달 뒤 상시 애니메이션(오로라/펄스) 정지 — backdrop blur 재계산으로 인한 스크롤바 깜빡임 방지
  document.body.classList.add('modal-open');
  // 이미 같은 모달이 스택 top 이면 push 중복 회피
  if (_modalStack[_modalStack.length - 1] !== id) {
    _modalStack.push(id);
    try { history.pushState({ wrModalId: id }, '', ''); } catch (_) {}
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
  if (!document.querySelector('.modal-ov.show')) document.body.classList.remove('modal-open');
  // 스택 top 이 이 모달이면 한 단계 pop + history.back() 으로 가상 entry 제거
  const top = _modalStack[_modalStack.length - 1];
  if (top === id) {
    _modalStack.pop();
    // history.state 가 우리가 push한 modal entry 인 경우만 back() — popstate 무한 루프 방지
    if (history.state && history.state.wrModalId === id) {
      try { history.back(); } catch (_) {}
    }
  }
}

// 뒤로가기 → 가장 위 모달 닫기
window.addEventListener('popstate', (e) => {
  const top = _modalStack[_modalStack.length - 1];
  if (!top) return;
  // 현재 history.state 가 우리 모달 state 가 아니면 = 뒤로 빠져나간 상태 → 모달 닫기만
  const el = document.getElementById(top);
  if (el) el.classList.remove('show');
  _modalStack.pop();
});

// 백드롭(모달 바깥 어두운 영역) 클릭 → 모달 닫기 (모든 .modal-ov 공통)
// 오버레이(.modal-ov) '자신'을 직접 클릭했을 때만. 내부 콘텐츠(.modal) 클릭은 무시.
// mousedown 과 click 이 둘 다 백드롭에서 일어났을 때만 닫아, 콘텐츠에서 시작해 바깥에서 끝난
// 드래그(텍스트 선택 등)로 실수로 닫히는 것을 방지.
let _mdOnBackdrop = null;
document.addEventListener('mousedown', (e) => {
  const t = e.target;
  _mdOnBackdrop = (t && t.classList && t.classList.contains('modal-ov')) ? t : null;
});
document.addEventListener('click', (e) => {
  const ov = e.target;
  if (ov && ov === _mdOnBackdrop && ov.classList.contains('modal-ov') && ov.classList.contains('show') && ov.id) {
    closeModal(ov.id);
  }
  _mdOnBackdrop = null;
});

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 조직 호칭(라벨) 커스터마이즈 ─────────────────────────────
// 기본값: 본부/팀/팀원/팀장/본부장. landing-config 의 org_labels 로 오버라이드.
//   · JS 렌더 라벨: orgLabel('team') 사용
//   · 정적 HTML 라벨: data-ol="{team} 관리" 처럼 템플릿 → applyOrgLabels() 가 주입
const ORG_LABELS = { division: '본부', team: '팀', member: '팀원', leader: '팀장', division_head: '본부장' };
function orgLabel(key) { return ORG_LABELS[key] || key; }
function setOrgLabels(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(ORG_LABELS)) {
      if (typeof obj[k] === 'string' && obj[k].trim()) ORG_LABELS[k] = obj[k].trim();
    }
  }
  applyOrgLabels();
}
// ── 조사(을/를 …) 자동 선택 ──────────────────────────────
// 호칭이 바뀌면 받침도 바뀐다: "유닛을" / "본부를". 하드코딩하면 한쪽이 반드시 틀린다.
const _JOSA_PAIRS = [['을','를'],['이','가'],['은','는'],['과','와'],['으로','로'],['아','야'],['이라','라']];
function _hasBatchim(word) {
  const c = (word || '').trim().slice(-1).charCodeAt(0);
  if (isNaN(c) || c < 0xAC00 || c > 0xD7A3) return false;   // 한글이 아니면 받침 없음 취급
  return (c - 0xAC00) % 28 !== 0;
}
// josa('유닛','을') → '유닛을' / josa('본부','을') → '본부를'
function josa(word, j) {
  const pair = _JOSA_PAIRS.find(p => p[0] === j || p[1] === j);
  if (!pair) return (word || '') + (j || '');
  return (word || '') + (_hasBatchim(word) ? pair[0] : pair[1]);
}
// 조직 호칭 + 조사 한 번에. olj('team','을') → '유닛을'
function olj(key, j) { return josa(orgLabel(key), j); }

// ── 브랜드(제품명/회사명/태그라인) ────────────────────────
// 오픈소스 기본값은 회사명 없이 제품명만. 배포처는 settings(team_id=0, key='brand')로 지정.
// 회사명이 비어도 " · " 같은 찌꺼기가 남지 않도록 조합 문자열을 여기서 만든다.
const BRAND = { product: 'Weekly Report', company: '', tagline: '' };
function setBrand(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(BRAND)) {
      if (typeof obj[k] === 'string') BRAND[k] = obj[k].trim();
    }
  }
  applyOrgLabels();   // 브랜드 토큰도 같은 파이프라인으로 주입
}
// 조합 토큰 — 빈 값이면 구분자까지 통째로 사라진다.
function _brandToken(k) {
  const { product, company, tagline } = BRAND;
  if (k === 'product') return product;
  if (k === 'company') return company;
  if (k === 'tagline') return tagline;
  if (k === 'brandsub') return [company, '주간보고'].filter(Boolean).join(' · ');
  if (k === 'copyright') {
    const who = [company, tagline].filter(Boolean).join(' · ');
    return who ? `© ${new Date().getFullYear()} ${who}` : '';
  }
  return '';
}

// 템플릿 문자열의 {division|team|member|leader|division_head} 를 현재 호칭으로 치환.
// {team:을} 처럼 조사를 붙이면 받침에 맞춰 을/를 자동 선택.
function fillOrgLabels(tpl) {
  return String(tpl).replace(
    /\{(division_head|division|team|member|leader|product|company|tagline|brandsub|copyright)(?::([^}]+))?\}/g,
    (_, k, j) => {
      const v = (k in ORG_LABELS) ? orgLabel(k) : _brandToken(k);
      return j ? josa(v, j) : v;
    }
  );
}
// data-ol      → textContent 치환. 예: data-ol="{team} 관리"
// data-ol-attr → 속성 치환. 예: data-ol-attr="placeholder:예) 각 {member} 라인 끝에|title:{leader} 지정"
//                (여러 속성은 | 로 구분, 속성명과 템플릿은 첫 : 로 분리)
//                textContent 를 못 쓰는 placeholder/title/aria-label 용.
function applyOrgLabels(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-ol]').forEach(el => {
    const tpl = el.getAttribute('data-ol');
    if (tpl) el.textContent = fillOrgLabels(tpl);
  });
  scope.querySelectorAll('[data-ol-attr]').forEach(el => {
    const spec = el.getAttribute('data-ol-attr');
    if (!spec) return;
    spec.split('|').forEach(pair => {
      const i = pair.indexOf(':');
      if (i < 1) return;
      const attr = pair.slice(0, i).trim();
      if (attr) el.setAttribute(attr, fillOrgLabels(pair.slice(i + 1)));
    });
  });
}

// 세부 역할 라벨 — sub_role 우선, 없으면 메인 role 한국어 fallback
function subRoleLabel(name) {
  if (typeof user !== 'undefined' && user && user.name === name && user.sub_role) return user.sub_role;
  const m = (typeof members !== 'undefined') ? members?.find(x => x.name === name) : null;
  if (m?.sub_role) return m.sub_role;
  const role = m?.role || 'etc';
  return role === 'dev' ? '개발자' : role === 'ops' ? '운영자' : '기타';
}

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 3000);
}
