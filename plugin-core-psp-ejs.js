/**
 * Cœur PSP – PPSSPP via EmulatorJS (plugin "core")
 * ------------------------------------------------------------
 * EmulatorJS (RetroArch + PPSSPP compilés en WebAssembly) est chargé depuis son CDN.
 * Le Service Worker met ces fichiers en cache : après le 1er lancement en ligne,
 * le moteur PSP refonctionne hors-ligne.
 *
 * ⚠ Expérimental : écrit d'après la documentation publique d'EmulatorJS, non testé
 *   avec le vrai CDN. Les points incertains sont marqués "à confirmer".
 *
 * Contraintes connues :
 *  - PPSSPP exige l'isolation cross-origin (SharedArrayBuffer) : fournie par sw.js à partir
 *    du 2e chargement de la page.
 *  - EmulatorJS charge le jeu en mémoire : préférer un petit jeu pour un 1er essai.
 *  - Après avoir quitté un jeu PSP, il faut recharger la page avant d'en relancer un.
 */
const DEFAULT_DATA = 'https://cdn.emulatorjs.org/stable/data/';

// Boutons → indices libretro utilisés par EmulatorJS (à confirmer)
const BTN = { cross: 0, square: 1, share: 2, options: 3, up: 4, down: 5, left: 6, right: 7,
              circle: 8, triangle: 9, l1: 10, r1: 11, l2: 12, r2: 13 };
// Sticks → [indice +, indice −] (à confirmer)
const AXIS = { left_x: [16, 17], left_y: [18, 19], right_x: [20, 21], right_y: [22, 23] };

const find = (u8, text) => {
  const n = text.length;
  outer: for (let i = 0; i <= u8.length - n; i++) {
    for (let j = 0; j < n; j++) if (u8[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
};

/** Un ISO PSP contient le dossier racine « PSP_GAME » : on lit le vrai répertoire racine (ISO 9660),
 *  sans dépendre de sa position dans le fichier. Retourne true / false. */
async function isPspIso(rom) {
  try {
    const pvd = await rom.readRange(16 * 2048, 2048);
    if (pvd.length >= 190 && String.fromCharCode(...pvd.subarray(1, 6)) === 'CD001') {
      const dv = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength);
      const lba = dv.getUint32(156 + 2, true), len = dv.getUint32(156 + 10, true);   // enregistrement du répertoire racine
      if (lba > 0 && len > 0 && len <= 1024 * 1024) {
        const dir = await rom.readRange(lba * 2048, len);
        if (find(dir, 'PSP_GAME') >= 0) return true;
      }
    }
  } catch (e) { /* on retombe sur la recherche simple */ }
  const head = await rom.readRange(0, 2 * 1024 * 1024);
  return find(head, 'PSP_GAME') >= 0;
}

/** Trace d'avancement : écrite dans localStorage, relue au démarrage suivant de l'appli.
 *  Si la page est fermée par l'iPhone pendant le chargement, on saura à quelle étape. */
const TRACE_KEY = 'ps-psp-trace';
function trace(patch) {
  try {
    const cur = JSON.parse(localStorage.getItem(TRACE_KEY) || '{}');
    localStorage.setItem(TRACE_KEY, JSON.stringify(Object.assign(cur, patch, { at: Date.now() })));
  } catch (e) {}
}
function clearTrace() { try { localStorage.removeItem(TRACE_KEY); } catch (e) {} }

class PspEjsCore {
  constructor(ctx) {
    this.ctx = ctx;
    this.opts = Object.assign({ dataUrl: DEFAULT_DATA, startTimeoutMs: 120000, maxMB: 1536 }, (ctx.descriptor && ctx.descriptor.options) || {});
    this.started = null;
  }

  get emu() { return window.EJS_emulator || null; }

  async load(rom) {
    // 1) Seulement les jeux PSP (un .iso peut aussi être PS1/PS2)
    if (rom.ext === '.iso') {
      if (!(await isPspIso(rom))) { const e = new Error('ce fichier n’est pas un jeu PSP'); e.skip = true; throw e; }   // skip : pas une vraie erreur, un autre moteur prend le relais
    } else if (!['.cso', '.pbp'].includes(rom.ext)) {
      const e = new Error('format non géré par le moteur PSP'); e.skip = true; throw e;
    }

    // Vérifications de l'environnement : on les cumule pour tout afficher d'un coup
    const problems = [];
    if (!window.crossOriginIsolated) {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      problems.push(sw
        ? 'isolation refusée par Safari malgré le Service Worker'
        : 'isolation absente : rechargez la page 2 fois');
    }
    const mb = rom.size / 1048576;
    if (this.opts.maxMB > 0 && mb > this.opts.maxMB) {
      problems.push(`jeu trop gros (${mb.toFixed(0)} Mo > ${this.opts.maxMB} Mo max) : risque de fermeture par l’iPhone`);
    }
    if (window.__psEjsUsed) problems.push('rechargez la page avant de relancer un jeu PSP');
    if (problems.length) throw new Error(problems.join(' ; '));

    // 2) Conteneur dans l'écran de jeu existant (aucun élément du HTML n'est modifié)
    const wrap = document.querySelector('.game-screen-wrapper');
    if (!wrap) throw new Error('écran de jeu introuvable');
    this.host = document.createElement('div');
    this.host.id = 'ejs-psp-host';
    this.host.style.cssText = 'position:absolute;inset:0;z-index:2;background:#000';
    const player = document.createElement('div');
    player.id = 'ejs-psp-player';
    player.style.cssText = 'width:100%;height:100%';
    this.host.appendChild(player);
    this.style = document.createElement('style');
    this.style.textContent = '#ejs-psp-host .ejs_virtualGamepad_parent{display:none!important}';   // manette de l'app utilisée à la place (à confirmer)
    document.head.appendChild(this.style);
    wrap.appendChild(this.host);

    // 3) Le jeu : File adossé au disque (OPFS) → URL blob
    const file = await rom.asFile();
    this.blobUrl = URL.createObjectURL(file);

    // 4) Configuration EmulatorJS (variables globales documentées)
    const data = this.opts.dataUrl.endsWith('/') ? this.opts.dataUrl : this.opts.dataUrl + '/';
    this.started = new Promise((resolve) => { this._resolveStart = resolve; });
    Object.assign(window, {
      EJS_player: '#ejs-psp-player', EJS_core: 'psp', EJS_gameUrl: this.blobUrl, EJS_gameName: rom.name,
      EJS_pathtodata: data, EJS_threads: true, EJS_startOnLoaded: true, EJS_language: 'fr',
      EJS_onGameStart: () => { clearTrace(); this.observer && this.observer.disconnect(); this._resolveStart(true); }
    });
    window.__psEjsUsed = true;

    trace({ stage: 'moteur', mb: Math.round(mb), status: '' });
    // On note le dernier texte d'avancement affiché par EmulatorJS (« Decompress Game Core 99% »…)
    let lastWrite = 0;
    this.observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastWrite < 400) return;
      lastWrite = now;
      const el = this.host && (this.host.querySelector('.ejs_loading_text') || this.host);
      const txt = el && (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
      if (txt) trace({ status: txt });
    });
    this.observer.observe(this.host, { subtree: true, childList: true, characterData: true });

    if (window.appUI) window.appUI.toast('Chargement du moteur PSP (1re fois : plusieurs Mo)…');
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = data + 'loader.js';
      s.onload = () => { trace({ stage: 'jeu' }); resolve(); };
      s.onerror = () => { clearTrace(); reject(new Error('EmulatorJS injoignable (connexion nécessaire la 1re fois)')); };
      document.head.appendChild(s);
      this.script = s;
    });
  }

  async start() {
    const timeout = new Promise((_, rej) => setTimeout(() => { clearTrace(); rej(new Error('le moteur PSP ne démarre pas (délai dépassé)')); }, this.opts.startTimeoutMs));
    await Promise.race([this.started, timeout]);
  }

  setInput(name, value) {
    const emu = this.emu, gm = emu && emu.gameManager;
    if (!gm || !gm.simulateInput) return;
    try {
      if (BTN[name] !== undefined) gm.simulateInput(0, BTN[name], value ? 1 : 0);
      else if (AXIS[name]) {
        gm.simulateInput(0, AXIS[name][0], Math.round(Math.max(value, 0) * 32767));
        gm.simulateInput(0, AXIS[name][1], Math.round(Math.max(-value, 0) * 32767));
      }
    } catch (e) { /* API interne : peut varier selon la version */ }
  }

  pause() { try { const e = this.emu; e && e.pause && e.pause(); } catch (x) {} }
  resume() { try { const e = this.emu; e && e.play && e.play(); } catch (x) {} }
  stop() { this.pause(); }

  dispose() {
    clearTrace(); this.observer && this.observer.disconnect();
    try { const e = this.emu; e && e.callEvent && e.callEvent('exit'); } catch (x) {}
    this.host && this.host.remove();
    this.style && this.style.remove();
    this.blobUrl && URL.revokeObjectURL(this.blobUrl);
  }
}

export default {
  id: 'psp-ejs',
  async create(ctx) { return new PspEjsCore(ctx); }
};
