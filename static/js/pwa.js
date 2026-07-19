// ═══════════════════════════════════════
//  PWA & Web Push & 환경설정 모달
// ═══════════════════════════════════════

let _deferredInstallPrompt = null;
let _vapidPublicKey        = null;
let _userTriggeredInstall  = false;  // 사용자가 직접 설치 버튼을 눌렀는지 추적

// ── PWA 설치 프롬프트 캐치 (Android/Chrome) ──
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  console.log('[PWA] beforeinstallprompt 캐치 — 자동 설치 가능');
  updateInstallButtonState();
});

window.addEventListener('appinstalled', () => {
  console.log('[PWA] appinstalled 이벤트 수신');
  _deferredInstallPrompt = null;
  _userTriggeredInstall  = false;
  updateInstallButtonState();
  // 설치 완료 토스트 발화 안 함 — Chrome 이 일부 환경(특히 데스크탑)에서
  // 실제 설치 완료 전에 appinstalled 이벤트를 fire 하는 사례 확인.
  // "감지 안 되면 띄우지 말 것" 사용자 정책에 따라 침묵. 사용자는
  // 환경설정 모달의 '✅ 이미 설치된 앱입니다' 상태로 확인 가능.
});

// ── Service Worker 등록 ──
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[SW] 등록 완료:', reg.scope);
    return reg;
  } catch (e) {
    console.warn('[SW] 등록 실패:', e);
    return null;
  }
}

// ── 앱 초기화 시 SW 등록 + pwa_install_enabled 플래그 로드 ──
(function initPWA() {
  const initAll = () => {
    registerServiceWorker();
    // landing-config 의 pwa_install_enabled 캐시 (showInstallPromo / 설치버튼 비활성화 판정)
    // 부트스트랩(window.onload)이 landing 캐시를 채운 뒤 재사용하도록 지연 —
    // DOMContentLoaded 시점에 바로 부르면 별도 landing-config 왕복이 하나 더 나간다.
    const refresh = () => setTimeout(() => _refreshPwaInstallEnabled().catch(() => {}), 1500);
    if (document.readyState === 'complete') refresh();
    else window.addEventListener('load', refresh);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();

// ── SW 로부터 메시지 수신 ──
// push-received → in-app 상단 노티 표시
// sw-activated → SW 버전 변경 통보. 클라이언트 측 stale state 추가 정리 (caches API 보강)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'push-received') {
      showInAppPushNotification(msg);
    } else if (msg.type === 'sw-activated') {
      _handleSwVersionChange(msg.version || '');
    }
  });
}

// SW 버전 변경 감지 시 클라이언트 측 보강 정리 (SW activate 의 caches 정리와 별개로 한 번 더)
async function _handleSwVersionChange(newVer) {
  try {
    const oldVer = localStorage.getItem('wr_sw_ver') || '';
    if (newVer) localStorage.setItem('wr_sw_ver', newVer);
    if (!oldVer || oldVer === newVer) return;
    console.log(`[PWA] SW 버전 변경 ${oldVer} → ${newVer} — 클라이언트 측 stale 정리`);
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { console.warn('[PWA] SW 버전 변경 처리 실패:', e); }
}

// ── 상단 슬라이드인 인앱 푸쉬 노티 ──
// 우상단에서 슬라이드인. 5초 후 자동 닫힘. 클릭 시 url 로 이동.
function showInAppPushNotification({ title, body, url, tag }) {
  // 이전 노티가 떠 있으면 제거 (중복 방지)
  const existing = document.getElementById('inAppPushNoti');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'inAppPushNoti';
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:99999',
    'max-width:360px', 'min-width:260px',
    'background:var(--surface, #fff)', 'color:var(--text, #111)',
    'border:1px solid var(--border, #e5e7eb)', 'border-left:4px solid var(--brand-500, #2f5bea)',
    'border-radius:10px', 'box-shadow:0 8px 24px rgba(0,0,0,.12)',
    'padding:14px 16px', 'cursor:pointer',
    'font-family:inherit', 'font-size:13px', 'line-height:1.5',
    'transform:translateX(120%)', 'opacity:0',
    'transition:transform .3s ease, opacity .3s ease',
  ].join(';');
  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <div style="font-size:18px;flex-shrink:0">🔔</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;color:var(--text);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(title || '주간보고').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</div>
        <div style="color:var(--text2, #555);font-size:12px">${(body || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</div>
      </div>
      <button type="button" aria-label="닫기" style="background:none;border:none;color:var(--text3, #999);cursor:pointer;font-size:18px;line-height:1;padding:0 0 0 6px;flex-shrink:0">×</button>
    </div>
  `;
  document.body.appendChild(el);

  // 슬라이드인
  requestAnimationFrame(() => {
    el.style.transform = 'translateX(0)';
    el.style.opacity = '1';
  });

  let dismissTimer = null;
  function dismiss() {
    el.style.transform = 'translateX(120%)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
    if (dismissTimer) clearTimeout(dismissTimer);
  }
  // 5초 후 자동 닫힘
  dismissTimer = setTimeout(dismiss, 5000);

  // 닫기 버튼
  el.querySelector('button').addEventListener('click', e => { e.stopPropagation(); dismiss(); });

  // 본문 클릭 시 URL 이동 + 닫힘
  el.addEventListener('click', () => {
    if (url && url !== location.pathname) {
      try { location.href = url; } catch (_) {}
    }
    dismiss();
  });
}

// ── 카톡 인앱 브라우저 안내 (한 세션에 1회) ───────────────
//  카톡 안에서는 PWA 설치/푸시 알림이 안 되므로 외부 브라우저로 열도록 안내.
(function notifyKakaoInApp() {
  function show() {
    if (!isKakaoInApp()) return;
    if (sessionStorage.getItem('wr_kakao_inapp_notified') === '1') return;
    sessionStorage.setItem('wr_kakao_inapp_notified', '1');
    setTimeout(() => {
      if (typeof toast === 'function') {
        toast('카카오톡 안에서는 앱 설치 / 알림이 제한됩니다. 우측 상단 메뉴 → "다른 브라우저로 열기"를 권장합니다.', 'err');
      }
    }, 1500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();

// ── VAPID 공개키 로드 ──
async function loadVapidPublicKey() {
  if (_vapidPublicKey) return _vapidPublicKey;
  try {
    const res = await api('/api/push/vapid-public');
    _vapidPublicKey = res.public_key;
    return _vapidPublicKey;
  } catch (e) {
    console.warn('[Push] VAPID 키 로드 실패:', e);
    return null;
  }
}

// ── URL-safe base64 → Uint8Array ──
function urlBase64ToUint8Array(b64) {
  const pad  = '='.repeat((4 - b64.length % 4) % 4);
  const raw  = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── 현재 Push 구독 조회 ──
async function getPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return await reg.pushManager.getSubscription();
}

// ── Push 구독 활성화 ──
async function subscribePush() {
  const vapidKey = await loadVapidPublicKey();
  if (!vapidKey) { toast('서버 VAPID 키 오류', 'err'); return null; }

  const reg = await navigator.serviceWorker.ready;
  try {
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        member_name: user?.name || '',
        subscription: subscription.toJSON(),
      }),
    });
    return subscription;
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      toast('알림 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.', 'err');
    } else {
      toast('알림 구독 중 오류가 발생했습니다.', 'err');
      console.warn('[Push] 구독 오류:', e);
    }
    return null;
  }
}

// ── Push 구독 취소 ──
async function unsubscribePush() {
  const sub = await getPushSubscription();
  if (!sub) return;
  try {
    await api(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' });
    await sub.unsubscribe();
  } catch (e) { console.warn('[Push] 구독 취소 오류:', e); }
}

// ── 알림 토글 핸들러 (단일 토글: 마감/보완요청 통합) ──
async function togglePushSubscription(checkbox) {
  if (!('Notification' in window)) {
    checkbox.checked = false;
    toast('이 브라우저는 알림을 지원하지 않습니다.', 'err');
    return;
  }
  if (checkbox.checked) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      checkbox.checked = false;
      await updateNotificationUI();
      return;
    }
    const sub = await subscribePush();
    if (sub) {
      toast('🔔 알림이 활성화되었습니다.', 'ok');
    } else {
      checkbox.checked = false;
    }
  } else {
    await unsubscribePush();
    toast('알림이 비활성화되었습니다.', 'ok');
  }
  await updateNotificationUI();
}

// ── 알림 UI 상태 갱신 ──
//  PWA(앱) 환경에서만 실제 토글 노출, 브라우저 환경에서는 안내 박스로 대체.
async function updateNotificationUI() {
  const section    = document.getElementById('stgNotiSection');   // 실제 알림 토글 섹션
  const hiddenInfo = document.getElementById('stgNotiHidden');     // 미설치 안내 박스
  const deniedEl   = document.getElementById('stgNotiDenied');
  const toggleEl   = document.getElementById('stgNotiEnabled');
  const manualBtn  = document.getElementById('stgNotiManualEnable'); // 권한 재요청 버튼

  // PWA standalone 인지 확인 — 아니면 토글 숨기고 안내 표시
  if (!isStandaloneMode()) {
    if (section)    section.style.display    = 'none';
    if (hiddenInfo) hiddenInfo.style.display = '';
    if (manualBtn)  manualBtn.style.display  = 'none';
    return;
  }

  // PWA 환경 — 알림 섹션 노출
  if (section)    section.style.display    = '';
  if (hiddenInfo) hiddenInfo.style.display = 'none';

  const supported = ('Notification' in window) && ('PushManager' in window);
  if (!supported) {
    if (deniedEl) { deniedEl.textContent = '이 브라우저는 알림을 지원하지 않습니다.'; deniedEl.style.display = 'block'; }
    if (toggleEl) toggleEl.disabled = true;
    if (manualBtn) manualBtn.style.display = 'none';
    return;
  }

  if (Notification.permission === 'denied') {
    if (deniedEl) deniedEl.style.display = 'block';
    if (toggleEl) { toggleEl.checked = false; toggleEl.disabled = true; }
    if (manualBtn) manualBtn.style.display = 'none';
    return;
  }
  if (deniedEl) deniedEl.style.display = 'none';
  if (toggleEl) toggleEl.disabled = false;

  const sub = await getPushSubscription();
  if (toggleEl) toggleEl.checked = !!sub;

  // 권한 default 인데 아직 구독 없는 경우 → 수동 활성화 버튼 노출
  // (자동 prompt 를 놓쳤거나 iOS 처럼 user gesture 가 필요한 환경)
  if (manualBtn) {
    manualBtn.style.display = (Notification.permission === 'default' && !sub) ? '' : 'none';
  }
}

// ── PWA 설치 상태 UI 갱신 (환경설정 모달의 ⑤ 앱 설치 섹션) ──
// 변경 이력 (2026-05-14, 16차): `installPWA()` prompt() 호출 path 가 silent stuck 되는 케이스 회피.
// "설치 버튼" 단일 버튼 클릭 → prompt 호출 path 제거. 대신 iOS 와 동일한 단계 가이드를 노출.
// 사용자가 직접 Chrome 메뉴 (⋮ → 홈 화면에 추가) 를 통해 설치 → Chrome 의 stable install path 사용.
function updateInstallButtonState() {
  const statusDot  = document.getElementById('stgPwaStatusDot');
  const statusText = document.getElementById('stgPwaStatusText');
  const guideEl    = document.getElementById('stgInstallAndroidGuide');
  const doneEl     = document.getElementById('stgInstallAndroidDone');
  const disabledEl = document.getElementById('stgInstallAndroidDisabled');

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // 모든 상태 박스 일단 숨김 — 아래에서 1개만 표시
  if (guideEl)    guideEl.style.display    = 'none';
  if (doneEl)     doneEl.style.display     = 'none';
  if (disabledEl) disabledEl.style.display = 'none';

  if (isStandalone) {
    if (statusDot)  statusDot.textContent  = '🟢';
    if (statusText) statusText.textContent = '설치된 앱으로 실행 중';
    if (doneEl)     doneEl.style.display   = '';
  } else if (_saPwaInstallEnabled === false) {
    // 시스템 관리자가 PWA 설치 기능을 OFF
    if (statusDot)  statusDot.textContent  = '🚫';
    if (statusText) statusText.textContent = '앱 설치 기능 일시 중지 (관리자 설정)';
    if (disabledEl) disabledEl.style.display = '';
  } else {
    // 미설치 + 설치 허용 → 단계 가이드 노출
    if (statusDot)  statusDot.textContent  = '⚪';
    if (statusText) statusText.textContent = '브라우저에서 사용 중';
    if (guideEl)    guideEl.style.display  = '';
  }
}

// ── PWA 설치 실행 (레거시 호환용) ──
// 변경 이력 (2026-05-14, 16차): `_deferredInstallPrompt.prompt()` API path 가 Chrome 내부에서
// silent stuck 되는 케이스 다수 보고 (사용자 시점: "설치 중" 알림만 떴다 사라지고 어디에도 안 보임).
// 동일 폰에서 Chrome 메뉴 ⋮ → "홈 화면에 추가" 는 즉시 정상 작동 (같은 WebAPK 빌드 path).
// → prompt() API 사용 중단. 사용자에게 Chrome 메뉴 사용을 안내하는 방식으로 통일 (iOS UX 와 동일).
// 이 함수가 외부에서 호출될 경우 fallback 으로 토스트 안내만 표시.
function installPWA() {
  toast('📲 Chrome 우측 상단 ⋮ 메뉴 → "홈 화면에 추가" 를 탭해주세요.\n환경설정 ⚙️ 에서 자세한 단계를 볼 수 있어요.', 'info', 6000);
}

// ── 설치 promo 의 "설치" 트리거 (레거시 호환용) ──
// promo 의 Android 분기는 더 이상 직접 설치 버튼을 노출하지 않음. 단계 가이드만 표시.
// 외부에서 이 함수가 호출되면 토스트 안내만 표시.
function installFromPromo() {
  const overlay = document.getElementById('installPromo');
  if (overlay) overlay.classList.remove('show');
  installPWA();
}

// ── iOS 여부 판별 ──
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// ── 인앱 브라우저(카톡/라인/페북/인스타 등) 감지 ──
// 이런 환경은 PWA 설치 자체가 막혀 있으므로 설치 안내 대신 "외부 브라우저로 열기" 안내가 필요.
function isInAppBrowser() {
  const ua = (navigator.userAgent || '').toLowerCase();
  return /kakaotalk|fb_iab|fban|fbav|instagram|line\//.test(ua);
}

function isKakaoInApp() {
  return /kakaotalk/i.test(navigator.userAgent || '');
}

// ── PWA standalone 모드(앱으로 열림) 여부 ──
function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

// ── PWA 첫 진입 자동 권한 요청 + 자동 구독 ─────────────
// 권한 상태별 동작:
//   - 'default'(미답변)  → prompt 띄움 → granted 시 subscribe
//   - 'granted'(이미 허용) → 구독 객체 없으면 자동 subscribe
//   - 'denied'(거부)      → 자동 액션 없음 (브라우저 정책상 재요청 불가)
async function autoPromptNotificationIfNeeded() {
  try {
    const standalone = isStandaloneMode();
    const hasNotif = 'Notification' in window;
    const perm = hasNotif ? Notification.permission : 'unsupported';
    // 주의: api.js 의 `let user = null` 은 글로벌 스크립트 변수지 window.user 가 아님.
    // window.user 로 참조하면 항상 undefined → 자동 권한 요청이 항상 skip 되던 버그.
    const hasUser = (typeof user !== 'undefined') && !!user;
    console.log('[PWA] autoPrompt 진입 — standalone:', standalone, 'perm:', perm, 'user:', hasUser);

    if (!standalone) { console.log('[PWA] standalone 아님 — skip'); return; }
    if (!hasNotif)   { console.log('[PWA] Notification 미지원 — skip'); return; }
    if (!hasUser)    { console.log('[PWA] user 없음 — skip'); return; }

    // 'granted' 인데 구독 없으면 즉시 자동 subscribe
    if (perm === 'granted') {
      try {
        const existing = await getPushSubscription();
        console.log('[PWA] 권한 granted, 기존 구독:', !!existing);
        if (!existing) {
          const sub = await subscribePush();
          if (sub) toast('🔔 알림이 자동으로 활성화되었습니다.', 'ok');
        }
      } catch (e) {
        console.warn('[PWA] 자동 구독 실패:', e);
      }
      return;
    }

    if (perm !== 'default') {
      console.log(`[PWA] 권한이 '${perm}' — 자동 prompt 안 함`);
      return;
    }

    // 'default' → prompt
    setTimeout(async () => {
      try {
        console.log('[PWA] requestPermission 호출');
        toast('🔔 마감 알림을 받으려면 알림 권한을 허용해주세요.', 'info');
        await new Promise(r => setTimeout(r, 600));
        const permission = await Notification.requestPermission();
        console.log('[PWA] requestPermission 결과:', permission);
        if (permission === 'granted') {
          const sub = await subscribePush();
          if (sub) toast('🔔 알림이 활성화되었습니다.', 'ok');
        } else if (permission === 'denied') {
          toast('알림 권한이 거부되었습니다. 환경설정에서 다시 시도할 수 있어요.', 'info');
        }
      } catch (e) {
        console.warn('[PWA] 자동 권한 요청 실패:', e);
      }
    }, 1500);
  } catch (e) {
    console.warn('[PWA] autoPromptNotificationIfNeeded 실패:', e);
  }
}

// ── 사용자 명시 트리거: 환경설정 모달의 '알림 활성화' 버튼 ──────────
// 자동 prompt 를 놓친 경우 / iOS Safari 처럼 자동 trigger 불안한 환경에서 사용.
async function manualEnableNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    toast('이 브라우저는 알림을 지원하지 않습니다.', 'err');
    return;
  }
  if (!isStandaloneMode()) {
    toast('알림은 앱(홈 화면 추가) 환경에서만 작동합니다. 먼저 앱을 설치해주세요.', 'info');
    return;
  }
  try {
    if (Notification.permission === 'denied') {
      toast('브라우저가 알림 권한을 거부 상태로 기억하고 있습니다.\n브라우저 설정 → 사이트 권한 → 알림 에서 허용해주세요.', 'err');
      return;
    }
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') {
        toast('알림 권한이 허용되지 않았습니다.', 'info');
        return;
      }
    }
    const sub = await subscribePush();
    if (sub) {
      toast('🔔 알림이 활성화되었습니다.', 'ok');
      await updateNotificationUI();
    }
  } catch (e) {
    toast('알림 활성화 실패: ' + (e?.message || e), 'err');
    console.warn('[PWA] manualEnableNotifications 실패:', e);
  }
}

// ════════════════════════════════════════
//  앱 설치 유도 팝업 (Install Promo)
// ════════════════════════════════════════

// ── 모바일 기기 판별 ──
function _isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.innerWidth <= 768;
}

// ── 이미 설치된 앱인지 확인 ──
function _isAlreadyInstalled() {
  return isStandaloneMode();
}

// ── 팝업 표시 여부 판단 ──
// 시스템 관리자가 pwa_install_enabled=false 로 설정하면 promo 자체 표시 안 함.
// landing-config 응답을 비동기로 캐시해두고 동기 판정에 사용.
let _saPwaInstallEnabled = true;  // 기본 true. landing-config 로드 후 갱신.
async function _refreshPwaInstallEnabled() {
  try {
    if (typeof _getLanding === 'function') {
      const l = await _getLanding();
      _saPwaInstallEnabled = !(l && l.pwa_install_enabled === false);
    }
  } catch (_) { /* fallback: true */ }
  return _saPwaInstallEnabled;
}

function shouldShowInstallPromo() {
  const dbg = {
    mobile:        _isMobileDevice(),
    standalone:    _isAlreadyInstalled(),
    inAppBrowser:  isInAppBrowser(),
    never:         localStorage.getItem('wr_install_promo_never') === '1',
    dismissedAt:   parseInt(localStorage.getItem('wr_install_promo_dismissed_at') || '0', 10),
    pwaInstallEnabled: _saPwaInstallEnabled,
  };
  const dismissedRecent = dbg.dismissedAt && (Date.now() - dbg.dismissedAt < 3 * 86400000);
  const decision =
    dbg.mobile && !dbg.standalone && !dbg.inAppBrowser && !dbg.never && !dismissedRecent && dbg.pwaInstallEnabled;
  console.log('[InstallPromo] shouldShow?', decision, dbg, 'dismissedRecent:', !!dismissedRecent);
  return decision;
}

// ── localStorage 플래그 초기화 (환경설정 모달에서 사용자가 호출 가능) ──
function resetInstallPromoFlags() {
  localStorage.removeItem('wr_install_promo_never');
  localStorage.removeItem('wr_install_promo_dismissed_at');
  if (typeof toast === 'function') {
    toast('✅ 설치 안내 표시 설정이 초기화되었습니다. 새로고침하면 다시 표시됩니다.', 'ok');
  }
}

// ── 팝업 표시 ──
// 변경 이력 (2026-05-14, 16차): Android 분기도 iOS 와 동일하게 단계 가이드 표시.
// 기존: prompt() 캐치 가능 시 직접 설치 버튼 노출 → Chrome prompt API 의 silent stuck 위험.
// 변경: OS 분기만 두고 둘 다 단계 가이드. 사용자가 Chrome 메뉴 (⋮ → 홈 화면에 추가) 로 직접 설치.
function showInstallPromo() {
  if (!shouldShowInstallPromo()) return;
  const overlay    = document.getElementById('installPromo');
  if (!overlay) return;

  const iosEl      = document.getElementById('ipIOS');
  const androidEl  = document.getElementById('ipAndroid');

  if (isIOS()) {
    // iOS 단계 가이드
    if (iosEl)     iosEl.style.display     = 'block';
    if (androidEl) androidEl.style.display = 'none';
  } else {
    // Android 단계 가이드 (Chrome 메뉴 사용 안내) — prompt() 가능 여부와 무관
    if (iosEl)     iosEl.style.display     = 'none';
    if (androidEl) androidEl.style.display = 'block';
  }

  overlay.classList.add('show');
  console.log('[InstallPromo] 팝업 표시 (iOS:', isIOS(), ')');

  // 상단 신기능 배너와 동시에 표시되지 않도록 배너 닫기
  if (typeof dismissVerBanner === 'function') dismissVerBanner();
}

// ── 오버레이 배경 클릭 → 다음에 닫기 ──
function onInstallPromoOverlayClick(e) {
  if (e.target === e.currentTarget) dismissInstallPromo('later');
}

// ── 팝업 닫기 (action: 'later' | 'never') ──
function dismissInstallPromo(action) {
  const overlay = document.getElementById('installPromo');
  if (overlay) overlay.classList.remove('show');

  if (action === 'never') {
    localStorage.setItem('wr_install_promo_never', '1');
    console.log('[InstallPromo] 영구 닫기 저장');
  } else if (action === 'later') {
    localStorage.setItem('wr_install_promo_dismissed_at', String(Date.now()));
    console.log('[InstallPromo] 다음에 (3일 뒤 재표시)');
  }
}

// ════════════════════════════════════════
//  환경설정 모달
// ════════════════════════════════════════

function openSettings() {
  if (!user) { toast('로그인 후 이용할 수 있습니다.', 'err'); return; }

  // 드롭다운 닫기
  const drop = document.getElementById('userDrop');
  if (drop) drop.classList.remove('show');

  // ① 내 정보
  document.getElementById('stgName').textContent     = user.name     || '-';
  document.getElementById('stgPosition').textContent = user.position || '-';
  const role   = getRole(user?.name);
  const roleKr = role === 'dev' ? '개발' : role === 'ops' ? '운영' : '기타';
  document.getElementById('stgRole').textContent     = roleKr;
  document.getElementById('stgProject').textContent  = user.project  || '-';
  document.getElementById('stgSubRole').textContent  = user.sub_role || '-';

  // ①-2 아바타 꾸미기 에디터 초기화
  initAvatarEditor();

  // ② 이번 주 현황
  _refreshSettingsWeekStatus();

  // ③ 디스플레이
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('stgDarkMode').checked = isDark;
  _refreshWeekModeLabel();

  // ④ 알림 UI
  updateNotificationUI();

  // ⑤ 설치 UI (iOS / Android 분기)
  // pwa_install_enabled 최신 값 받아온 뒤 버튼 상태 갱신 (시스템 관리자 토글 즉시 반영)
  _refreshPwaInstallEnabled().then(() => {
    if (isIOS()) {
      document.getElementById('stgInstallAndroid').style.display = 'none';
      const iosEl = document.getElementById('stgInstallIOS');
      if (iosEl) {
        iosEl.style.display = 'block';
        // iOS 도 설치 차단 안내 — 별도 안내 박스로 표시
        if (_saPwaInstallEnabled === false) {
          iosEl.innerHTML = '<div style="padding:14px;background:var(--bg2);border:1px dashed var(--border);border-radius:10px;font-size:13px;color:var(--text2);line-height:1.6">🚫 현재 앱 설치 기능이 일시 중지되었습니다.<br>관리자에게 문의해주세요.</div>';
        }
      }
    } else {
      document.getElementById('stgInstallAndroid').style.display = 'block';
      document.getElementById('stgInstallIOS').style.display     = 'none';
      updateInstallButtonState();
    }
  });

  // 모달 스택 + Android 뒤로가기 처리 적용 (utils.js openModal)
  openModal('settingsModal');
}

function closeSettings() {
  closeModal('settingsModal');
}

// ─────────────────────────────────────────────
//  아바타 꾸미기 (환경설정 모달)
// ─────────────────────────────────────────────
// 작업 상태 — {img, bg(색 또는 그라데이션), border, shape, initial, effect(애니메이션)}
let _avatarState = { img: null, bg: null, border: null, shape: 'circle', initial: '', effect: null };

// 애니메이션 효과 목록
const _AVATAR_EFFECTS = [
  { id: null,        label: '없음' },
  { id: 'shine',     label: '✨ 반짝' },
  { id: 'pulse',     label: '💓 펄스' },
  { id: 'glow',      label: '🌟 글로우' },
  { id: 'float',     label: '🎈 둥실' },
  { id: 'shake',     label: '🫨 살랑' },
  { id: 'bounce',    label: '⛹️ 통통' },
  { id: 'heartbeat', label: '❤️ 두근' },
  { id: 'spin',      label: '🔄 빙글' },
  { id: 'rainbow',   label: '🌈 무지개' },
];
function _renderAvatarEffects() {
  const wrap = document.getElementById('avatarEffects');
  if (!wrap) return;
  wrap.innerHTML = _AVATAR_EFFECTS.map((e, i) => {
    const active = (_avatarState.effect || null) === e.id;
    const style = active
      ? 'background:var(--brand-600);color:#fff;border:1px solid var(--brand-600)'
      : 'background:var(--surface2);color:var(--text2);border:1px solid var(--border)';
    return `<button type="button" onclick="applyAvatarEffect(${i})" style="${style};font-size:12px;font-weight:600;padding:5px 10px;border-radius:7px;cursor:pointer">${e.label}</button>`;
  }).join('');
}
function applyAvatarEffect(i) {
  const e = _AVATAR_EFFECTS[i];
  if (!e) return;
  _avatarState.effect = e.id;
  _renderAvatarEffects();
  renderAvatarPreview();
}

// 원클릭 효과 프리셋
const _AVATAR_PRESETS = [
  { name: '기본',     bg: null,  border: null },
  { name: '블루',     bg: 'linear-gradient(135deg,#5680ff,#1a36a3)' },
  { name: '바이올렛', bg: 'linear-gradient(135deg,#a78bfa,#6a5cff)' },
  { name: '민트',     bg: 'linear-gradient(135deg,#33d6da,#1f6feb)' },
  { name: '오션',     bg: 'linear-gradient(135deg,#2af598,#009efd)' },
  { name: '선셋',     bg: 'linear-gradient(135deg,#ff8a3d,#d7263d)' },
  { name: '골드',     bg: 'linear-gradient(135deg,#f7971e,#ffd200)' },
  { name: '체리',     bg: 'linear-gradient(135deg,#eb3349,#f45c43)' },
  { name: '포레스트', bg: 'linear-gradient(135deg,#16a26b,#0f5132)' },
  { name: '핑크',     bg: 'linear-gradient(135deg,#ff7eb3,#ff4d6d)' },
  { name: '라벤더',   bg: 'linear-gradient(135deg,#c471f5,#fa71cd)' },
  { name: '스카이',   bg: 'linear-gradient(135deg,#56ccf2,#2f80ed)' },
  { name: '피치',     bg: 'linear-gradient(135deg,#ffecd2,#fcb69f)' },
  { name: '에메랄드', bg: 'linear-gradient(135deg,#11998e,#38ef7d)' },
  { name: '미드나잇', bg: 'linear-gradient(135deg,#2b2f44,#414767)' },
  { name: '다크',     bg: 'linear-gradient(135deg,#232526,#414345)' },
  { name: '네온',     bg: 'linear-gradient(135deg,#0cf25d,#0a8f3c)', border: '#aaffcc' },
  { name: '글로우',   bg: 'linear-gradient(135deg,#5680ff,#1a36a3)', border: '#9ec1ff' },
];

function _renderAvatarPresets() {
  const wrap = document.getElementById('avatarPresets');
  if (!wrap || !user) return;
  const def = (typeof nameToAvatarBg === 'function') ? nameToAvatarBg(user.name) : '#3b82f6';
  wrap.innerHTML = _AVATAR_PRESETS.map((p, i) => {
    const bg = p.bg || def;
    const ring = p.border ? `box-shadow:0 0 0 2px ${p.border};` : '';
    return `<button type="button" title="${p.name}" onclick="applyAvatarPreset(${i})" style="width:34px;height:34px;border-radius:50%;border:1px solid var(--border);cursor:pointer;background:${bg};${ring}"></button>`;
  }).join('');
}

function applyAvatarPreset(i) {
  const p = _AVATAR_PRESETS[i];
  if (!p) return;
  _avatarState.bg = p.bg;                 // null = 이름 기반 기본 그라데이션
  _avatarState.border = p.border || null; // 일부 프리셋(글로우/네온)은 링 색 포함
  renderAvatarPreview();
}

function onAvatarShape(s) { _avatarState.shape = s; renderAvatarPreview(); }
function onAvatarInitial() {
  const el = document.getElementById('avatarInitial');
  _avatarState.initial = el ? el.value.trim().slice(0, 4) : '';
  renderAvatarPreview();
}

function initAvatarEditor() {
  if (!user) return;
  const cfg = (typeof avatarCfg === 'function') ? avatarCfg(user.name) : null;
  _avatarState = {
    img:     (cfg && cfg.img)     || null,
    bg:      (cfg && cfg.color)   || null,
    border:  (cfg && cfg.border)  || null,
    shape:   (cfg && cfg.shape)   || 'circle',
    initial: (cfg && cfg.initial) || '',
    effect:  (cfg && cfg.effect)  || null,
  };
  const initEl = document.getElementById('avatarInitial');
  if (initEl) initEl.value = _avatarState.initial;
  document.querySelectorAll('input[name="avatarShape"]').forEach(r => { r.checked = (r.value === _avatarState.shape); });
  _renderAvatarPresets();
  _renderAvatarEffects();
  renderAvatarPreview();
}

function renderAvatarPreview() {
  const el = document.getElementById('avatarPreview');
  if (!el || !user) return;
  const s = _avatarState;
  el.classList.remove('ava-fx-shine','ava-fx-pulse','ava-fx-glow','ava-fx-float','ava-fx-shake','ava-fx-bounce','ava-fx-heartbeat','ava-fx-spin','ava-fx-rainbow');
  if (s.effect) el.classList.add('ava-fx-' + s.effect);
  el.style.borderRadius = (s.shape === 'rounded') ? '28%' : '50%';
  el.style.boxShadow = s.border ? `0 0 0 3px ${s.border}` : '';
  if (s.img) {
    el.innerHTML = '';
    el.style.backgroundImage = `url('${s.img}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundImage = 'none';
    el.style.background = s.bg || (typeof nameToAvatarBg === 'function' ? nameToAvatarBg(user.name) : '#3b82f6');
    el.innerHTML = (typeof avaInnerHTML === 'function') ? avaInnerHTML(s.initial || avaInitial(user.name)) : esc(s.initial || (user.name || '?').charAt(0));
  }
}

// 이미지 → 정사각 center-crop 후 size×size 로 축소한 JPEG dataURL
function _resizeImageToDataURL(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function onAvatarFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('이미지 파일만 가능합니다.', 'err'); event.target.value=''; return; }
  try {
    _avatarState.img = await _resizeImageToDataURL(file, 256);
    renderAvatarPreview();
  } catch (e) {
    toast('이미지 처리 실패: ' + (e.message || e), 'err');
  } finally {
    event.target.value = '';
  }
}

function clearAvatarPhoto() {
  _avatarState.img = null;
  renderAvatarPreview();
}

// 저장 후 모든 아바타 렌더 지점 즉시 갱신
function _refreshAllAvatars() {
  try { if (typeof applyUserToUI === 'function') applyUserToUI(); } catch (_) {}
  try { if (typeof populateLoginSel === 'function') populateLoginSel(); } catch (_) {}
  try { if (typeof applyUserToSidebar === 'function') applyUserToSidebar(); } catch (_) {}
  try { if (typeof renderDash === 'function' && (isAdmin || isApprover)) renderDash(); } catch (_) {}
}

async function saveAvatar() {
  if (!user) return;
  const s = _avatarState;
  if (typeof showActionLoader === 'function') showActionLoader('아바타 저장 중...');
  try {
    await api(`/api/members/${encodeURIComponent(user.name)}/avatar`, {
      method: 'PUT',
      body: JSON.stringify({
        img:     s.img     || null,
        color:   s.bg      || null,
        initial: s.initial || null,
        border:  s.border  || null,
        shape:   s.shape   || 'circle',
        effect:  s.effect  || null,
      }),
    });
    // 로컬 members 갱신 → 모든 아바타 즉시 재렌더
    const cfg = {};
    if (s.img) cfg.img = s.img;
    if (s.bg) cfg.color = s.bg;
    if (s.initial) cfg.initial = s.initial;
    if (s.border) cfg.border = s.border;
    if (s.shape === 'rounded') cfg.shape = 'rounded';
    if (s.effect) cfg.effect = s.effect;
    const m = (members || []).find(x => x.name === user.name);
    if (m) m.avatar_config = Object.keys(cfg).length ? JSON.stringify(cfg) : '';
    _refreshAllAvatars();
    toast('아바타가 저장되었습니다 🎨', 'ok');
  } catch (e) {
    toast('저장 실패: ' + (e.message || e), 'err');
  } finally {
    if (typeof hideActionLoader === 'function') hideActionLoader();
  }
}

async function resetAvatar() {
  _avatarState = { img: null, bg: null, border: null, shape: 'circle', initial: '', effect: null };
  const initEl = document.getElementById('avatarInitial'); if (initEl) initEl.value = '';
  document.querySelectorAll('input[name="avatarShape"]').forEach(r => { r.checked = (r.value === 'circle'); });
  _renderAvatarEffects();
  renderAvatarPreview();
  await saveAvatar();
}

async function _refreshSettingsWeekStatus() {
  const badge    = document.getElementById('stgSubmitBadge');
  const deadText = document.getElementById('stgDeadlineText');

  try {
    // /api/reports/{name} 은 관리자 전용 → 일반 사용자는 /my 사용 (403 방지)
    const r = await api(`/api/reports/my?week=${currentWriteWeek}`);
    if (r && r.submitted_at) {
      badge.textContent = '✅ 제출완료';
      badge.className   = 'settings-status-badge submitted';
    } else {
      badge.textContent = '⏳ 미제출';
      badge.className   = 'settings-status-badge pending';
    }
  } catch {
    badge.textContent = '⏳ 미제출';
    badge.className   = 'settings-status-badge pending';
  }

  if (_deadlineInfo && _deadlineInfo.enabled && _deadlineInfo.deadline_at) {
    if (_deadlineInfo.is_passed) {
      deadText.textContent = '🔒 이미 마감되었습니다';
    } else if (_deadlineInfo.remaining_seconds > 0) {
      const h = Math.floor(_deadlineInfo.remaining_seconds / 3600);
      const m = Math.floor((_deadlineInfo.remaining_seconds % 3600) / 60);
      deadText.textContent = `⏱ 마감까지 ${h}시간 ${m}분 남음`;
    }
  } else {
    deadText.textContent = '마감 설정 없음';
  }
}

function _refreshWeekModeLabel() {
  const el = document.getElementById('stgWeekModeLabel');
  if (!el) return;
  el.textContent = weekMode === 0
    ? 'ISO 주차 (예: 26년 19주차)'
    : '월·주차 (예: 26년 4월 5주)';
}

// 환경설정 모달의 다크모드 토글
function toggleThemeFromSettings(checkbox) {
  const theme = checkbox.checked ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('wr_theme', theme);
  applyThemeIcon(theme);
}

// 환경설정 모달의 주차 표시 변경
function toggleWeekModeFromSettings() {
  toggleWeekMode();
  _refreshWeekModeLabel();
}
