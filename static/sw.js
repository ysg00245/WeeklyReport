// ═══════════════════════════════════════
//  Weekly Report — Service Worker
//  Push 알림 수신 + 클릭 처리
// ═══════════════════════════════════════

const SW_VER = '3.0.2';

self.addEventListener('install', event => {
  console.log(`[SW] 설치 완료 v${SW_VER}`);
  self.skipWaiting(); // 즉시 활성화
});

// 진단 (2026-05-13): Chrome 의 site data 에 옛 SW 가 남긴 캐시·state 가 stuck 되면
// 새 PWA install 시도가 background retry queue 에서 통과 못 하고 사용자 시점 수분~수십분 대기.
// 사이트 데이터 수동 정리해야만 풀리는 케이스. 사용자가 손 안 대도 풀리도록 자가 정리:
//  - activate 시 caches 전부 비움 (옛 manifest/asset 캐시 잔존 차단)
//  - 활성 클라이언트에 sw-activated postMessage → 클라이언트 측에서도 localStorage 측 stale 키 정리
self.addEventListener('activate', event => {
  console.log(`[SW] 활성화 v${SW_VER}`);
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      if (keys.length) {
        console.log(`[SW] 옛 캐시 ${keys.length}개 정리:`, keys);
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) { console.warn('[SW] 캐시 정리 실패:', e); }

    await clients.claim(); // 열린 탭 즉시 제어

    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        try { c.postMessage({ type: 'sw-activated', version: SW_VER }); } catch (_) {}
      }
    } catch (e) { console.warn('[SW] 클라이언트 broadcast 실패:', e); }
  })());
});

// ── fetch 핸들러 ────────────────────────────────────────────
// PWA installability 검증 충족용 — Chrome 은 SW 가 start_url 에 응답
// 가능한지(특히 오프라인 시) 확인하려고 fetch 핸들러 존재를 요구함.
// 핸들러가 없으면 데스크탑 Chrome 에서 "설치 진행중" 단계가 무한 대기.
//
// 정책:
//  - 네비게이션 요청: 네트워크 우선, 실패 시 간단한 오프라인 안내 페이지
//  - 그 외 요청(이미지/JS/CSS/API): SW 미개입 (브라우저 기본 동작)
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>오프라인 · 주간보고</title></head>' +
        '<body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,Pretendard,sans-serif;' +
        'text-align:center;padding:48px 24px;color:#0f1f5c;background:#fff">' +
        '<h2 style="margin:0 0 12px;font-weight:800">네트워크에 연결되어 있지 않습니다</h2>' +
        '<p style="margin:0;color:#555">연결이 복구되면 새로고침해 주세요.</p>' +
        '</body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )
    )
  );
});

// ── Push 이벤트 수신 ──
// 정책:
//  - 앱이 visible(포커스 있음) 상태 → OS 노티 띄우지 않고 in-app 노티만 (클라이언트가 처리)
//  - 앱이 hidden/닫힘 → OS 노티 표시 (기존 동작)
// 양쪽 모두 클라이언트에 postMessage 로 데이터 전달 — 앱은 그 메시지로 in-app UI 갱신/노티 표시.
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '주간보고', body: event.data.text() };
  }

  const title   = data.title || '주간보고 시스템';
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/static/img/app-icon.png',
    badge:   data.badge   || '/static/img/app-icon.png',
    vibrate: [150, 80, 150],
    tag:     data.tag     || 'weekly-report',
    renotify: true,
    data:    { url: data.url || '/' },
  };

  event.waitUntil((async () => {
    // 모든 클라이언트 조회
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = allClients.find(c => c.focused) || allClients.find(c => c.visibilityState === 'visible');

    // 클라이언트들에 메시지 broadcast — 앱이 켜져있으면 in-app 노티 표시용
    for (const c of allClients) {
      try {
        c.postMessage({
          type:  'push-received',
          title, body: options.body, url: options.data.url, tag: options.tag,
        });
      } catch (_) {}
    }

    // visible 클라이언트가 있으면 OS 노티는 띄우지 않음 (앱이 in-app 노티로 처리)
    if (focused) return;

    // 앱이 백그라운드/닫힘 → OS 노티 표시
    await self.registration.showNotification(title, options);
  })());
});

// ── 알림 클릭 → 앱 포커스 또는 오픈 ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // 이미 열린 탭이 있으면 포커스
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // 없으면 새 탭 열기
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
