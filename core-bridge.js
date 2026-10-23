/* ===== core-bridge.js ===== */
/**
 * ============================================================
 *  EmulatorCore – PASSERELLE vers les moteurs d'émulation (plugins)
 * ============================================================
 *
 *  Même API publique qu'avant (init / loadRom / start / stop / setInput /
 *  applySettings / getStats + isReady / isRunning / currentRom), donc l'UI,
 *  la manette et le chargeur de jeux n'ont pas changé.
 *
 *  Ce qui change : plus rien n'est simulé. EmulatorCore
 *    • choisit un moteur dans le registre (PS.registry) selon le fichier,
 *    • l'importe à la volée (import() dynamique),
 *    • lui donne le <canvas id="game-canvas"> (WebGL2 / WebGPU / 2D),
 *    • lui transmet l'état de la manette (boutons + sticks),
 *    • lui applique les réglages,
 *    • mesure FPS / CPU / mémoire pour le moniteur de l'accueil.
 *
 * ------------------------------------------------------------
 *  CONTRAT D'UN PLUGIN "core"  (plugins/cores/<nom>/index.js)
 * ------------------------------------------------------------
 *  export default {
 *    id: 'mon-moteur',
 *    async create(ctx) {            // ctx : voir _makeContext()
 *      return {
 *        async load(rom) {},        // rom = RomHandle (voir storage.js)
 *        async start() {},
 *        pause() {}, resume() {},   // optionnels
 *        stop() {},                 // optionnel
 *        dispose() {},              // libérer WASM / GL / workers
 *        setInput(name, value, info) {},   // optionnel (modèle "push")
 *        applySettings(settings) {},       // optionnel
 *        getStats() { return { fps, cpu, ram, vram }; }  // optionnel
 *      };
 *    }
 *  };
 *
 *  Noms de boutons envoyés : cross circle square triangle l1 r1 l2 r2
 *  up down left right share options home   (valeur 0 ou 1)
 *  Axes : left_x left_y right_x right_y     (valeur -1..1, bas = +1)
 */
(function () {
  'use strict';

  const PS = (window.PS = window.PS || {});

  /* Numéros stables (disposition DualShock) pour les cœurs qui préfèrent des entiers */
  const BUTTONS = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
                    share: 8, options: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15, home: 16 };
  const AXES = { left_x: 0, left_y: 1, right_x: 2, right_y: 3 };

  const DEFAULT_SETTINGS = { scale: 2, frameskip: 0, filter: 'none', sensitivity: 1, haptic: true, showFps: true };

  /* ------------------------------------------------------------------ */
  /*  Boucle de cadence (rAF + pas fixe), branchée sur les stats        */
  /* ------------------------------------------------------------------ */
  class FrameLoop {
    constructor(host, { fps = 60, onFrame }) {
      this.host = host; this.fps = fps; this.onFrame = onFrame;
      this.running = false; this.frameskip = host.settings.frameskip | 0; this._n = 0;
      this._tick = this._tick.bind(this);
    }
    start() {
      if (this.running) return;
      this.running = true; this._acc = 0; this._last = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }
    stop() { this.running = false; cancelAnimationFrame(this._raf); }
    setFps(fps) { this.fps = fps || 60; }
    setFrameskip(n) { this.frameskip = n | 0; }
    _tick(t) {
      if (!this.running) return;
      this._raf = requestAnimationFrame(this._tick);
      const step = 1000 / this.fps;
      let dt = t - this._last; this._last = t;
      if (dt > 250 || dt < 0) dt = step;          // onglet resté en arrière-plan
      this._acc += dt;
      let n = 0;
      while (this._acc >= step - 0.5 && n < 4) {
        this._acc -= step; n++;
        const skip = this.frameskip > 0 && (this._n++ % (this.frameskip + 1)) !== 0;
        const t0 = performance.now();
        try { this.onFrame(skip); }
        catch (e) { this.stop(); this.host._fatal(e); return; }
        this.host._reportFrame(performance.now() - t0, step, skip);
      }
      if (this._acc > step * 4) this._acc = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  EmulatorCore                                                      */
  /* ------------------------------------------------------------------ */
  const EmulatorCore = {
    // État public (inchangé)
    isReady: false,
    isRunning: false,
    currentRom: null,

    // État interne
    state: 'idle',            // idle | loading | ready | running | paused
    settings: Object.assign({}, DEFAULT_SETTINGS),
    core: null, activeDesc: null, rom: null,
    _renderers: [], _loops: [], _canvas: null, _canvasDirty: false, _origSize: { w: 640, h: 448 },
    _input: { buttons: new Float32Array(17), axes: new Float32Array(4) },
    _stat: { frames: 0, shown: 0, emuMs: 0, budgetMs: 16.7, fps: 0, cpu: 0, t: 0, lastCall: 0 },
    _listeners: {},
    _autoPaused: false,
    _stopPromise: null,

    /* ----- événements simples ----- */
    on(evt, fn) { (this._listeners[evt] = this._listeners[evt] || new Set()).add(fn); return () => this._listeners[evt].delete(fn); },
    _emit(evt, data) { (this._listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
    _setState(s) { this.state = s; this._emit('state', s); },

    /* ------------------------------------------------------------------ */
    /*  Initialisation (appelée au démarrage de l'application)            */
    /* ------------------------------------------------------------------ */
    async init() {
      console.log('[Core] Initialisation de la passerelle…');
      const canvas = document.getElementById('game-canvas');
      if (canvas) this._origSize = { w: canvas.width, h: canvas.height };
      this._canvas = canvas;

      // Stockage + catalogue de composants (en parallèle)
      await Promise.all([
        PS.storage.init().catch(e => console.warn('[Core] stockage', e)),
        PS.registry.loadCatalog()
      ]);

      this.caps = PS.ComponentRegistry.detectCaps();
      console.log('[Core] Capacités :', this.caps, '| stockage :', PS.storage.backendName);

      this._bindLifecycle();
      this.isReady = true;

      // Préchargement silencieux du code (pas du WASM) pour un démarrage instantané + cache hors-ligne
      const idle = window.requestIdleCallback || (fn => setTimeout(fn, 600));
      idle(() => {
        PS.registry.resolveRenderers().forEach(d => PS.registry.preload(d.id));
        PS.registry.list('core').filter(d => PS.registry.meets(d)).forEach(d => PS.registry.preload(d.id));
      });
      console.log('[Core] Passerelle prête');
      return true;
    },

    /** Informations de diagnostic (console : EmulatorCore.getInfo()) */
    getInfo() {
      return {
        state: this.state,
        engine: this.activeDesc && { id: this.activeDesc.id, name: this.activeDesc.name, version: this.activeDesc.version },
        renderer: this._renderers[0] && this._renderers[0].info,
        storage: PS.storage.backendName,
        caps: this.caps,
        components: PS.registry.list().map(d => `${d.kind}:${d.id}@${d.version}`)
      };
    },

    /** Forcer un moteur (ex. EmulatorCore.setPreferredCore('ps1-wasm')) – mémorisé. */
    setPreferredCore(id) { try { id ? localStorage.setItem('ps-preferred-core', id) : localStorage.removeItem('ps-preferred-core'); } catch (e) {} },

    /* ------------------------------------------------------------------ */
    /*  Chargement d'un jeu                                               */
    /* ------------------------------------------------------------------ */
    /**
     * @param {File|Object|string} ref  File, méta du stockage {id,…} ou id
     */
    async loadRom(ref) {
      if (this._stopPromise) await this._stopPromise;
      await this._teardown();
      this._setState('loading');

      let handle;
      try {
        if (typeof File !== 'undefined' && ref instanceof File) handle = PS.RomStorage.handleFromFile(ref);
        else handle = await PS.storage.open(ref);
      } catch (e) { this._setState('idle'); throw e; }

      console.log('[Core] Chargement de :', handle.name, `(${(handle.size / 1048576).toFixed(1)} Mo)`);
      this.currentRom = ref;
      this.rom = handle;

      let preferred = null;
      try { preferred = localStorage.getItem('ps-preferred-core'); } catch (e) {}
      const candidates = PS.registry.resolveCores({ ext: handle.ext, name: handle.name }, preferred);
      if (!candidates.length) { this._setState('idle'); throw new Error('Aucun moteur compatible avec ce format'); }

      let lastErr = null, firstReal = null;
      for (let i = 0; i < candidates.length; i++) {
        const desc = candidates[i];
        try {
          const api = await PS.registry.load(desc.id);
          const ctx = this._makeContext(desc);
          const core = await api.create(ctx);
          await core.load(handle);
          this.core = core; this.activeDesc = desc;
          this._applyToRenderers();
          this._setState('ready');
          if (firstReal && window.appUI) window.appUI.toast(`${firstReal.name} : ${firstReal.msg} → ${desc.name}`, '');
          console.log('[Core] Moteur actif :', desc.id, desc.version);
          return true;
        } catch (e) {
          lastErr = e;
          if (!firstReal && !(e && e.skip)) firstReal = { name: desc.name, msg: (e && e.message) || 'indisponible' };
          console.warn(`[Core] ${desc.id} a échoué :`, e && e.message ? e.message : e);
          await this._teardown();        // nettoie rendu / boucles / canvas partiellement utilisés
          this.rom = handle; this.currentRom = ref;
        }
      }
      this._setState('idle');
      throw lastErr || new Error('Impossible de charger le jeu');
    },

    /* ------------------------------------------------------------------ */
    /*  Démarrage / pause / arrêt                                         */
    /* ------------------------------------------------------------------ */
    async start() {
      if (!this.core) {
        if (!this.currentRom) throw new Error('Aucun ROM chargé');
        await this.loadRom(this.currentRom);          // relance après un arrêt
      }
      console.log('[Core] Démarrage de l’émulation');
      this._resetStats();
      this._replayInputs();
      await this.core.start();
      this.isRunning = true;
      this._autoPaused = false;
      this._setState('running');
    },

    pause() {
      if (!this.isRunning || !this.core) return;
      this._loops.forEach(l => l.stop());
      try { this.core.pause && this.core.pause(); } catch (e) {}
      this.isRunning = false;
      this._setState('paused');
    },

    resume() {
      if (this.state !== 'paused' || !this.core) return;
      this._loops.forEach(l => l.start());
      try { this.core.resume && this.core.resume(); } catch (e) {}
      this.isRunning = true;
      this._setState('running');
    },

    /** Arrête et libère le moteur (appel synchrone pour l'UI ; nettoyage asynchrone). */
    stop() {
      console.log('[Core] Arrêt');
      this.isRunning = false;
      this._autoPaused = false;
      this._stopPromise = this._teardown().finally(() => { this._stopPromise = null; });
      return this._stopPromise;
    },

    async _teardown() {
      const core = this.core;
      this.core = null;
      this._loops.forEach(l => l.stop()); this._loops = [];
      if (core) {
        try { core.stop && await core.stop(); } catch (e) { console.warn('[Core] stop', e); }
        try { core.dispose && await core.dispose(); } catch (e) { console.warn('[Core] dispose', e); }
      }
      this._renderers.forEach(r => { try { r.dispose && r.dispose(); } catch (e) {} });
      this._renderers = [];
      if (this.rom && this.rom.release) { try { this.rom.release(); } catch (e) {} }
      this.rom = null; this.activeDesc = null;
      this._input.buttons.fill(0); this._input.axes.fill(0);
      this._resetStats(true);
      if (this.state !== 'loading') this._setState('idle');
    },

    _fatal(err) {
      console.error('[Core] erreur fatale', err);
      this.stop();
      if (window.appUI) window.appUI.toast('Erreur du moteur : ' + (err && err.message || err), 'error');
      this._emit('error', err);
    },

    /* ------------------------------------------------------------------ */
    /*  Contexte fourni aux plugins                                       */
    /* ------------------------------------------------------------------ */
    _makeContext(desc) {
      const host = this;
      const pluginBase = new URL('.', new URL(desc.url, PS.registry.base)).href;
      let ownCanvas = null;
      return {
        /** Canvas vierge, réservé à ce moteur (pour un cœur qui crée son propre contexte GL, ex. Emscripten). */
        get canvas() { return ownCanvas || (ownCanvas = host._acquireCanvas()); },
        caps: host.caps,
        settings: Object.assign({}, host.settings),
        descriptor: desc,
        storage: PS.storage,
        BUTTONS, AXES,
        input: {
          buttons: host._input.buttons,           // Float32Array(17) – lecture directe (modèle "pull")
          axes: host._input.axes,                 // Float32Array(4)
          snapshot: () => ({ buttons: Array.from(host._input.buttons), axes: Array.from(host._input.axes) })
        },
        assetUrl: (rel) => new URL(rel, pluginBase).href,
        log: (...a) => console.log(`[${desc.id}]`, ...a),

        /** Crée un présentateur vidéo (WebGL2 → WebGPU → Canvas2D) lié au canvas. */
        createRenderer: (opts = {}) => host._createRenderer(opts),

        /** Boucle de cadence : { start(), stop(), setFps(n), setFrameskip(n) } */
        createLoop: (opts) => { const l = new FrameLoop(host, opts); host._loops.push(l); return l; },

        /** Pour les cœurs qui cadencent eux-mêmes (ex. emscripten_set_main_loop) */
        report: {
          frame: (emuMs, budgetMs) => host._reportFrame(emuMs, budgetMs || 1000 / 60, false)
        },
        fatal: (e) => host._fatal(e)
      };
    },

    /**
     * Fournit un <canvas id="game-canvas"> sans contexte (un canvas ne peut jamais changer
     * de type de contexte : WebGL → WebGPU → 2D). Si l'actuel a déjà servi, il est remplacé
     * par un clone identique (mêmes id / classes / attributs) : la structure HTML ne change pas.
     */
    _acquireCanvas() {
      let c = this._canvas || document.getElementById('game-canvas');
      if (this._canvasDirty && c) {
        const fresh = c.cloneNode(false);
        fresh.width = this._origSize.w; fresh.height = this._origSize.h;
        c.replaceWith(fresh);
        c = fresh;
      }
      this._canvas = c;
      this._canvasDirty = true;
      return c;
    },

    async _createRenderer(opts = {}) {
      let prefer = null;
      try { const p = localStorage.getItem('ps-preferred-renderer'); if (p) prefer = [p]; } catch (e) {}
      const list = PS.registry.resolveRenderers(prefer);
      let lastErr = null;
      for (const desc of list) {
        try {
          const api = await PS.registry.load(desc.id);
          const canvas = this._acquireCanvas();
          const r = await api.create({ canvas, scale: this.settings.scale, filter: this.settings.filter });
          this._renderers.push(r);
          console.log('[Core] Rendu :', r.info && r.info.api, r.info && r.info.renderer);
          return r;
        } catch (e) {
          lastErr = e;
          console.warn(`[Core] renderer ${desc.id} :`, e && e.message ? e.message : e);
        }
      }
      throw lastErr || new Error('Aucun moteur de rendu disponible');
    },

    /* ------------------------------------------------------------------ */
    /*  Manette → moteur                                                  */
    /* ------------------------------------------------------------------ */
    /**
     * @param {string} button  cross, triangle, l1, left_x, …
     * @param {number} value   0|1 pour un bouton, -1..1 pour un stick
     */
    setInput(button, value) {
      const bi = BUTTONS[button], ai = AXES[button];
      let kind, idx, v, prev;
      if (bi !== undefined) {
        kind = 'button'; idx = bi; v = value ? 1 : 0; prev = this._input.buttons[idx];
        if (prev === v) return;
        this._input.buttons[idx] = v;
      } else if (ai !== undefined) {
        kind = 'axis'; idx = ai; v = Math.max(-1, Math.min(1, +value || 0)); prev = this._input.axes[idx];
        if (prev === v || (v !== 0 && Math.abs(prev - v) < 0.004)) return;
        this._input.axes[idx] = v;
      } else return;

      const core = this.core;
      if (core && core.setInput && (this.isRunning || this.state === 'ready')) {
        try { core.setInput(button, v, { kind, index: idx, port: 0 }); } catch (e) { console.warn('[Core] setInput', e); }
      }
    },

    _replayInputs() {
      const core = this.core;
      if (!core || !core.setInput) return;
      Object.keys(BUTTONS).forEach(n => { const v = this._input.buttons[BUTTONS[n]]; if (v) core.setInput(n, v, { kind: 'button', index: BUTTONS[n], port: 0 }); });
      Object.keys(AXES).forEach(n => { const v = this._input.axes[AXES[n]]; if (v) core.setInput(n, v, { kind: 'axis', index: AXES[n], port: 0 }); });
    },

    /* ------------------------------------------------------------------ */
    /*  Réglages                                                          */
    /* ------------------------------------------------------------------ */
    applySettings(settings) {
      console.log('[Core] Application des paramètres :', settings);
      this.settings = Object.assign({}, this.settings, settings || {});
      this._applyToRenderers();
      this._loops.forEach(l => l.setFrameskip(this.settings.frameskip));
      if (this.core && this.core.applySettings) {
        try { this.core.applySettings(Object.assign({}, this.settings)); } catch (e) { console.warn('[Core] applySettings', e); }
      }
    },

    _applyToRenderers() {
      this._renderers.forEach(r => {
        try { r.setScale && r.setScale(this.settings.scale); r.setFilter && r.setFilter(this.settings.filter); } catch (e) {}
      });
    },

    /* ------------------------------------------------------------------ */
    /*  Statistiques réelles                                              */
    /* ------------------------------------------------------------------ */
    _resetStats(full) {
      this._stat = { frames: 0, shown: 0, emuMs: 0, budgetMs: 16.7, fps: 0, cpu: 0, t: performance.now(), lastCall: performance.now() };
    },

    _reportFrame(emuMs, budgetMs, skipped) {
      const s = this._stat;
      s.frames++; if (!skipped) s.shown++;
      s.emuMs += emuMs; s.budgetMs = budgetMs || s.budgetMs;
    },

    getStats() {
      const s = this._stat, now = performance.now();
      const dt = now - s.lastCall;
      if (dt >= 500) {                                   // fenêtre glissante ~1 s
        s.fps = this.isRunning ? Math.round(s.frames * 1000 / dt) : 0;
        s.cpu = this.isRunning && s.frames ? Math.min(100, Math.round((s.emuMs / s.frames) / s.budgetMs * 100)) : 0;
        s.frames = 0; s.emuMs = 0; s.lastCall = now;
      }
      let ram = 0;
      try { if (performance.memory) ram = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
      const c = this._canvas;
      let vram = 0;
      if (this.isRunning && c) vram = Math.round(c.width * c.height * 4 * 3 / 1048576);

      let out = { fps: s.fps, cpu: s.cpu, ram, vram };
      if (this.core && this.core.getStats) {
        try { const x = this.core.getStats() || {}; out = Object.assign(out, x); } catch (e) {}
      }
      return out;
    },

    /* ------------------------------------------------------------------ */
    /*  Cycle de vie de l'onglet (économie batterie mobile)               */
    /* ------------------------------------------------------------------ */
    _bindLifecycle() {
      if (this._lifecycleBound) return;
      this._lifecycleBound = true;
      const onHide = () => { if (this.isRunning) { this._autoPaused = true; this.pause(); } };
      const onShow = () => { if (this._autoPaused) { this._autoPaused = false; this.resume(); } };
      document.addEventListener('visibilitychange', () => document.hidden ? onHide() : onShow());
      window.addEventListener('pagehide', onHide);
      window.addEventListener('pageshow', onShow);
    }
  };

  window.EmulatorCore = EmulatorCore;
  PS.FrameLoop = FrameLoop;
})();
