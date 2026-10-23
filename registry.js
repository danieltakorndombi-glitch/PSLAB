/* ===== registry.js ===== */
/**
 * ============================================================
 *  REGISTRE DE COMPOSANTS (plugins chargés à la volée)
 * ============================================================
 *
 *  Chaque composant (moteur d'émulation, moteur de rendu…) est décrit par un
 *  "descripteur" JSON. Le code du composant n'est téléchargé et exécuté qu'au
 *  moment où on en a besoin, via import() dynamique.
 *
 *  Descripteur :
 *  {
 *    id:         "ps1-wasm",                 // unique
 *    kind:       "core" | "renderer" | ...   // famille de composant
 *    name:       "PS1 (WASM)",
 *    version:    "1.0.0",                    // sert de cache-buster (?v=)
 *    url:        "plugin-core-ps1-wasm.js",
 *    systems:    ["ps1"],                    // (core) systèmes gérés
 *    extensions: [".bin", ".cue", ".chd"],   // (core) extensions gérées
 *    priority:   100,                        // plus grand = essayé en premier
 *    requires:   { wasm: true, webgl2: true } // capacités nécessaires
 *  }
 *
 *  Ajouter un moteur SANS toucher à l'application :
 *    1. déposer le dossier du plugin dans /plugins/cores/…
 *    2. ajouter son descripteur dans registry.json
 *  (ou, à chaud : window.PS.registry.define({...}))
 */
(function () {
  'use strict';

  const PS = (window.PS = window.PS || {});

  class ComponentRegistry {
    constructor() {
      this.items = new Map();      // id -> descripteur
      this.modules = new Map();    // id -> Promise<module>
      this.listeners = new Map();  // event -> Set<fn>
      this.base = new URL('./', document.baseURI).href;
      this.blobUrls = new Map();   // url -> blob: URL (mode "fichier unique")
    }

    /* ---------- événements ---------- */
    on(evt, fn) {
      if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
      this.listeners.get(evt).add(fn);
      return () => this.listeners.get(evt)?.delete(fn);
    }
    emit(evt, data) {
      this.listeners.get(evt)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
    }

    /* ---------- déclaration ---------- */
    define(desc) {
      if (!desc || !desc.id || !desc.kind || !desc.url) {
        throw new Error('[Registry] descripteur invalide (id, kind, url requis)');
      }
      const prev = this.items.get(desc.id);
      const next = Object.assign({ priority: 0, systems: [], extensions: [], requires: {}, version: '0' }, desc);
      // Nouvelle version → on invalide le module déjà importé
      if (prev && prev.version !== next.version) this.modules.delete(desc.id);
      this.items.set(desc.id, next);
      this.emit('define', next);
      return next;
    }

    undefine(id) {
      this.items.delete(id);
      this.modules.delete(id);
      this.emit('undefine', id);
    }

    get(id) { return this.items.get(id) || null; }

    list(kind) {
      return [...this.items.values()]
        .filter(d => !kind || d.kind === kind)
        .sort((a, b) => b.priority - a.priority);
    }

    /**
     * Charge un catalogue JSON (ex. registry.json).
     * Réseau d'abord ; le Service Worker sert la copie en cache hors-ligne.
     */
    async loadCatalog(url = 'registry.json') {
      try {
        const opts = { cache: 'no-cache' };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(3500);
        const res = await fetch(new URL(url, this.base), opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        (json.components || []).forEach(d => this.define(d));
        this.catalogVersion = json.version || null;
        return true;
      } catch (e) {
        console.info('[Registry] catalogue distant indisponible, descripteurs intégrés utilisés →', e.message);
        return false;
      }
    }

    /* ---------- sélection ---------- */
    /** Capacités du navigateur courant (calculées une fois). */
    static detectCaps() {
      if (ComponentRegistry._caps) return ComponentRegistry._caps;
      let webgl2 = false, webgl = false;
      try {
        const c = document.createElement('canvas');
        webgl2 = !!c.getContext('webgl2');
        webgl = webgl2 || !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch (e) {}
      const caps = {
        wasm: typeof WebAssembly === 'object',
        webgl, webgl2,
        webgpu: !!navigator.gpu,
        opfs: !!(navigator.storage && navigator.storage.getDirectory),
        sab: typeof SharedArrayBuffer !== 'undefined',
        isolated: !!window.crossOriginIsolated,
        threads: typeof SharedArrayBuffer !== 'undefined' && !!window.crossOriginIsolated,
        offscreen: typeof OffscreenCanvas !== 'undefined'
      };
      ComponentRegistry._caps = caps;
      return caps;
    }

    meets(desc) {
      const caps = ComponentRegistry.detectCaps();
      return Object.entries(desc.requires || {}).every(([k, v]) => !v || !!caps[k]);
    }

    /** Moteurs candidats pour un fichier (triés par priorité). */
    resolveCores(meta, preferredId) {
      const ext = (meta && meta.ext ? meta.ext : '').toLowerCase();
      const cores = this.list('core').filter(d => this.meets(d));
      const matching = cores.filter(d => !d.extensions.length || d.extensions.includes(ext));
      if (preferredId) {
        const pref = matching.find(d => d.id === preferredId);
        if (pref) return [pref, ...matching.filter(d => d !== pref)];
      }
      return matching;
    }

    /** Premier moteur de rendu compatible (ordre de préférence donné). */
    resolveRenderers(prefer) {
      const all = this.list('renderer').filter(d => this.meets(d));
      if (!prefer || !prefer.length) return all;
      const rank = id => { const i = prefer.indexOf(id); return i < 0 ? 999 : i; };
      return all.sort((a, b) => rank(a.id) - rank(b.id) || b.priority - a.priority);
    }

    /* ---------- chargement dynamique ---------- */
    _resolveUrl(desc) {
      const u = new URL(desc.url, this.base);
      if (desc.version && desc.version !== '0') u.searchParams.set('v', desc.version);
      return u;
    }

    async _import(desc) {
      // Mode "fichier unique" : le code du plugin est embarqué dans index.html
      const embedded = (PS.embedded || {})[desc.url];
      if (embedded) {
        let blobUrl = this.blobUrls.get(desc.url);
        if (!blobUrl) {
          blobUrl = URL.createObjectURL(new Blob([embedded], { type: 'text/javascript' }));
          this.blobUrls.set(desc.url, blobUrl);
        }
        return import(blobUrl);
      }
      // Mode normal : vrai fichier .js sur le serveur
      return import(this._resolveUrl(desc).href);
    }

    /** Charge (et met en cache) le module d'un composant. */
    load(id) {
      const desc = this.items.get(id);
      if (!desc) return Promise.reject(new Error(`[Registry] composant inconnu : ${id}`));
      if (!this.modules.has(id)) {
        const p = this._import(desc).then(mod => {
          const api = mod.default || mod;
          if (!api || typeof api.create !== 'function') {
            throw new Error(`[Registry] "${id}" doit exporter { create(ctx) }`);
          }
          this.emit('loaded', desc);
          return api;
        });
        p.catch(() => this.modules.delete(id)); // permet de réessayer
        this.modules.set(id, p);
      }
      return this.modules.get(id);
    }

    /** Précharge sans instancier (idle). */
    preload(id) { return this.load(id).catch(e => console.info('[Registry] preload', id, e.message)); }
  }

  /* ---------- descripteurs intégrés (repli si registry.json injoignable) ---------- */
  const BUILTIN = [
    { id: 'webgl2', kind: 'renderer', name: 'WebGL2', version: '1.0.0', url: 'plugin-renderer-webgl2.js', priority: 100, requires: { webgl2: true } },
    { id: 'webgpu', kind: 'renderer', name: 'WebGPU', version: '1.0.0', url: 'plugin-renderer-webgpu.js', priority: 50,  requires: { webgpu: true } },
    { id: 'canvas2d', kind: 'renderer', name: 'Canvas 2D', version: '1.0.0', url: 'plugin-renderer-canvas2d.js', priority: -100, requires: {} },
    { id: 'ps1-wasm', kind: 'core', name: 'PlayStation 1 (WASM)', version: '1.0.0', url: 'plugin-core-ps1-wasm.js',
      systems: ['ps1'], extensions: ['.bin', '.cue', '.iso', '.img', '.chd', '.pbp', '.cso'], priority: 100, requires: { wasm: true } },
    { id: 'demo', kind: 'core', name: 'Diagnostic (sans WASM)', version: '1.0.0', url: 'plugin-core-demo.js',
      systems: ['any'], extensions: [], priority: -100, requires: { webgl: true } }
  ];

  PS.ComponentRegistry = ComponentRegistry;
  PS.registry = new ComponentRegistry();
  BUILTIN.forEach(d => PS.registry.define(d));
})();
