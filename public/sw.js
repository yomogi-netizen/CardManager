/* オフライン用 Service Worker
   - アプリ本体(HTML/JS/CSS)を端末に保存し、圏外でも起動できるようにする
   - Supabase など別オリジンへの通信・画像は対象外 (App.jsx 側の IndexedDB / Cache API が担当)
   - 更新したいときは VERSION を変えるだけでOK */
const VERSION = "v1";
const CACHE = `card-app-shell-${VERSION}`;
const SCOPE = new URL("./", self.registration.scope).pathname; // 例: "/" or "/repo/"
const INDEX = SCOPE + "index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([SCOPE, INDEX, SCOPE + "manifest.webmanifest", SCOPE + "icons/icon-192.png"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("card-app-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase・外部画像は触らない

  // ページ遷移: ネット優先、失敗したら保存済みの index.html
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(INDEX, copy));
          return res;
        })
        .catch(() => caches.match(INDEX).then((r) => r || caches.match(SCOPE)))
    );
    return;
  }

  // ハッシュ付きの JS/CSS (/assets/): 内容が変わるとファイル名も変わるので、保存済みがあれば通信しない
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // アイコンなど: 保存済みを即返しつつ裏で更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
