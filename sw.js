/* ============================================================
 *  PS Web Emulator – Service Worker
 * ============================================================
 *  Objectifs : démarrage INSTANTANÉ hors-ligne + mises à jour en ligne
 *  sans jamais mélanger deux versions de l'application.
 *
 *  Trois familles de ressources, trois stratégies :
 *
 *  1. COQUE de l'application  (index.html, *.js, manifeste, icônes)
 *     → "cache atomique versionné". La liste et l'empreinte (version) viennent
 *       de asset-manifest.json. Réponse immédiate depuis le cache ; en
 *       arrière-plan on compare asset-manifest.json (jamais mis en cache HTTP) :
 *       si la version a changé, TOUTE la nouvelle coque est téléchargée dans un
 *       nouveau cache, puis activée d'un seul coup. Aucun redéploiement manuel
 *       de numéro de version : le build calcule l'empreinte.
 *
 *  2. PLUGINS (plugins/**.js, registry.json, BIOS…)  → mises à jour "à chaud"
 *     • registry.json : réseau d'abord (3 s max) puis cache  → un nouveau moteur
 *       déclaré apparaît dès la prochaine ouverture en ligne.
 *     • modules .js   : stale-while-revalidate → instantané + mis à jour en fond.
 *       (Changer `version` dans registry.json force le téléchargement immédiat,
 *        car l'URL du module change : ?v=<version>.)
 *
 *  3. BINAIRES WASM (*.wasm, gros fichiers) → cache d'abord, jamais retéléchargés
 *     tant que leur URL (?v=…) ne change pas.
 *
 *  Les ROMs ne passent jamais par ici : elles vivent dans OPFS / IndexedDB.
 *
 *  Isolation cross-origin (COOP/COEP) : GitHub Pages ne permet pas de poser ces
 *  en-têtes ; le Service Worker les ajoute, ce qui active SharedArrayBuffer et
 *  donc les cœurs WASM multi-threads (pthreads). Actif dès le 2e chargement.
 *  Mettre ENABLE_ISOLATION à false si vous chargez des ressources externes.
 */
'use strict';

const ENABLE_ISOLATION = true;
const SHELL_PREFIX = 'ps-shell-';
const RUNTIME = 'ps-runtime-v1';
const WASM = 'ps-wasm-v1';
const META = 'ps-meta-v1';
const CDN = 'ps-cdn-v1';                                   // fichiers EmulatorJS (moteur PSP) mis en cache pour le hors-ligne
const CDN_HOSTS = ['cdn.emulatorjs.org'];
const CHECK_EVERY_MS = 60 * 1000;

const SCOPE = self.registration.scope;                       // ex. https://user.github.io/repo/
const SCOPE_PATH = new URL(SCOPE).pathname;
const MANIFEST_URL = new URL('asset-manifest.json', SCOPE).href;
const POINTER_KEY = new URL('__current-shell', SCOPE).href;  // clé fictive dans le cache META
const INDEX_URL = new URL('index.html', SCOPE).href;

let lastCheck = 0;

/* ------------------------------------------------------------------ */
/*  Utilitaires                                                       */
/* ------------------------------------------------------------------ */
function withIsolation(res) {
  if (!ENABLE_ISOLATION || !res || res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0 || res.status === 206) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function fetchWithTimeout(url, ms, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({}, init, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

async function fetchManifest() {
  const res = await fetchWithTimeout(MANIFEST_URL, 5000, { cache: 'no-store' });
  if (!res.ok) throw new Error('asset-manifest HTTP ' + res.status);
  return res.json();
}

async function readPointer() {
  const meta = await caches.open(META);
  const r = await meta.match(POINTER_KEY);
  return r ? r.json().catch(() => null) : null;
}

async function writePointer(ptr) {
  const meta = await caches.open(META);
  await meta.put(POINTER_KEY, new Response(JSON.stringify(ptr), { headers: { 'content-type': 'application/json' } }));
}

async function currentShell() {
  const ptr = await readPointer();
  return ptr ? caches.open(ptr.cache) : null;
}

/* ------------------------------------------------------------------ */
/*  Installation d'une version de la coque (atomique)                 */
/* ------------------------------------------------------------------ */
async function installVersion(manifest) {
  const ptr = await readPointer();
  if (ptr && ptr.version === manifest.version && await caches.has(ptr.cache)) return false;

  const name = SHELL_PREFIX + manifest.version;
  await caches.delete(name);                         // reprise propre après un téléchargement interrompu
  const cache = await caches.open(name);

  // Tout ou rien : si un seul fichier échoue, rien n'est activé
  await Promise.all(manifest.shell.map(async (rel) => {
    const req = new Request(new URL(rel, SCOPE).href, { cache: 'reload' });
    const res = await fetch(req);
    if (!res.ok) throw new Error(`${rel} → HTTP ${res.status}`);
    await cache.put(req, res);
  }));

  // Plugins « de base » : présents hors-ligne dès la première installation
  const rt = await caches.open(RUNTIME);
  await Promise.all((manifest.precache || []).map(async (rel) => {
    const url = new URL(rel, SCOPE).href;
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await rt.put(url, res);            // remplace : la copie du serveur fait foi
    } catch (e) { /* hors-ligne ou absent : sans gravité */ }
  }));

  await writePointer({ cache: name, version: manifest.version, at: Date.now() });

  // On garde la version précédente (pages encore ouvertes), on supprime le reste
  const keep = new Set([name, ptr && ptr.cache].filter(Boolean));
  for (const k of await caches.keys()) {
    if (k.startsWith(SHELL_PREFIX) && !keep.has(k)) await caches.delete(k);
  }
  return true;
}

async function notifyClients(msg) {
  const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  list.forEach(c => c.postMessage(msg));
}

async function checkForUpdate(notify = true) {
  try {
    const manifest = await fetchManifest();
    const updated = await installVersion(manifest);
    if (updated && notify) await notifyClients({ type: 'UPDATE_READY', version: manifest.version });
    return updated;
  } catch (e) {
    return false;                                    // hors-ligne : on garde la version en cache
  }
}

function scheduleCheck(event) {
  const now = Date.now();
  if (now - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = now;
  event.waitUntil(checkForUpdate(true));
}

/* ------------------------------------------------------------------ */
/*  Cycle de vie                                                      */
/* ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const manifest = await fetchManifest();          // échec → installation retentée plus tard
    await installVersion(manifest);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const ptr = await readPointer();
    for (const k of await caches.keys()) {
      const ours = k.startsWith('ps-');
      const live = k === RUNTIME || k === WASM || k === META || k === CDN || (ptr && k === ptr.cache);
      if (ours && !live && !k.startsWith(SHELL_PREFIX)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'CHECK_UPDATE') event.waitUntil(checkForUpdate(true));
  else if (type === 'SKIP_WAITING') self.skipWaiting();
  else if (type === 'CLEAR_RUNTIME') event.waitUntil(Promise.all([caches.delete(RUNTIME), caches.delete(WASM)]));
  else if (type === 'GET_VERSION') {
    event.waitUntil(readPointer().then(p => event.source && event.source.postMessage({ type: 'VERSION', version: p && p.version })));
  }
});

/* ------------------------------------------------------------------ */
/*  Stratégies                                                        */
/* ------------------------------------------------------------------ */
async function shellResponse(req, event) {
  const cache = await currentShell();
  let res = null;
  if (cache) res = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(INDEX_URL));
  if (!res) {
    try { res = await fetch(req); }
    catch (e) { res = new Response('Hors-ligne : ouvrez l’application une première fois en ligne.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }
  }
  scheduleCheck(event);
  return withIsolation(res);
}

async function shellAsset(req, event) {
  const cache = await currentShell();
  const hit = cache && await cache.match(req, { ignoreSearch: true });
  if (hit) return withIsolation(hit);
  return withIsolation(await staleWhileRevalidate(req, RUNTIME, event));
}

async function staleWhileRevalidate(req, cacheName, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req, { cache: 'no-cache' })
    .then(res => { if (res && res.ok) cache.put(req, res.clone()).catch(() => {}); return res; })
    .catch(() => null);
  if (hit) { event.waitUntil(net); return hit; }
  const res = await net;
  return res || Response.error();
}

async function networkFirst(req, cacheName, ms) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetchWithTimeout(req.url, ms, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    return hit || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { try { await cache.put(req, res.clone()); } catch (e) { /* quota */ } }
  return res;
}

/* CDN d'EmulatorJS : récupéré en mode CORS, servi avec CORP (exigé par l'isolation COEP), mis en cache */
async function cdnFetch(req) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    try { await cache.put(req.url, out.clone()); } catch (e) { /* quota */ }
    return out;
  } catch (e) {
    return fetch(req);                                // repli : requête d'origine (peut échouer hors-ligne)
  }
}

/* ------------------------------------------------------------------ */
/*  Routage                                                           */
/* ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_HOSTS.includes(url.hostname) && !req.headers.has('range')) { event.respondWith(cdnFetch(req)); return; }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;  // externe : navigateur
  if (req.headers.has('range')) return;                                                    // flux média : navigateur

  const path = decodeURIComponent(url.pathname.slice(SCOPE_PATH.length));

  if (path === 'sw.js') return;                                    // le navigateur gère sa propre mise à jour

  if (req.mode === 'navigate') { event.respondWith(shellResponse(req, event)); return; }

  if (path === 'asset-manifest.json') {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => Response.error()));
    return;
  }
  if (path === 'registry.json') { event.respondWith(networkFirst(req, RUNTIME, 3000).then(withIsolation)); return; }
  if (path.endsWith('.wasm') || /\.(data|mem)$/.test(path)) { event.respondWith(cacheFirst(req, WASM).then(withIsolation)); return; }
  if (path.startsWith('plugin-')) { event.respondWith(staleWhileRevalidate(req, RUNTIME, event).then(withIsolation)); return; }

  event.respondWith(shellAsset(req, event));
});
