/**
 * Passerelle WebAssembly (Emscripten) – plugin core "ps1-wasm"
 * ============================================================
 * Ce plugin ne contient PAS d'émulateur : il sait charger n'importe quel cœur
 * compilé avec Emscripten qui respecte l'ABI ci-dessous (voir
 * docs/BUILD-CORE.md pour compiler un cœur libretro : SwanStation, Beetle PSX,
 * PCSX-ReARMed…), puis le relie au canvas, à la manette et au stockage.
 *
 * Fichiers à déposer (non fournis, ils dépendent du cœur choisi) :
 *   plugins/cores/ps1-wasm/core/ps1.js      glue Emscripten (-sMODULARIZE -sEXPORT_ES6)
 *   plugins/cores/ps1-wasm/core/ps1.wasm
 *   plugins/cores/ps1-wasm/bios/scphXXXX.bin  BIOS PS1 (à fournir soi-même)
 *
 * ------------------------------------------------------------
 *  ABI C attendue (EMSCRIPTEN_KEEPALIVE / -sEXPORTED_FUNCTIONS)
 * ------------------------------------------------------------
 *  int    ps_init(const char* system_dir);        // 0 = OK ; BIOS dans system_dir
 *  int    ps_caps(void);                          // bit0: /opfs monté (WasmFS+OPFS) · bit1: framebuffer logiciel · bit2: rendu GL direct
 *  int    ps_load(const char* path);              // chemin dans le FS Emscripten ; 0 = OK
 *  void   ps_run_frame(int skip_render);          // exécute UNE trame
 *  void   ps_set_button(int index, int pressed);  // index = EmulatorCore BUTTONS (cross=0 … home=16)
 *  void   ps_set_axis(int index, float value);    // index = AXES (left_x=0 … right_y=3), -1..1, bas = +1
 *  void   ps_set_option(const char* key, int v);  // scale, frameskip, filter(0|1|2), show_fps
 *  void   ps_reset(void);
 *  void   ps_shutdown(void);
 *  --- framebuffer logiciel (si ps_caps() & 2) ---
 *  int    ps_video_ptr(void);    int ps_video_width(void);   int ps_video_height(void);
 *  int    ps_video_format(void); // 0 = RGBA8888, 1 = XRGB8888 (BGRA en mémoire), 2 = RGB565
 *  int    ps_video_pitch(void);  // octets par ligne (optionnel)
 *  --- optionnel ---
 *  double ps_fps(void);          // 59.94 (NTSC) / 50 (PAL)
 *  int    ps_stat(int id);       // 0 = CPU %, 1 = RAM Mo, 2 = VRAM Mo
 *
 * Lecture des gros jeux sans saturer la RAM :
 *   • Si le cœur est compilé avec WasmFS + backend OPFS (ps_caps() & 1), le jeu est lu
 *     DIRECTEMENT dans OPFS (/opfs/ps-roms/<id>.rom) : zéro copie.
 *   • Sinon le jeu est copié par blocs de 8 Mo dans le FS mémoire d'Emscripten
 *     (limite configurable : options.maxMemfsMB).
 */

const DEFAULTS = {
  glue: 'ps1.js',
  global: 'createPS1Module',      // nom du constructeur si le glue n'est pas un module ES
  esm: true,
  bios: ['scph5501.bin', 'scph1001.bin', 'scph7001.bin', 'scph5500.bin', 'scph5502.bin', 'scph7502.bin'],
  maxMemfsMB: 640
};
const MB = 1048576;

/** Vérifie la présence d'un fichier (GET, corps ignoré : fonctionne aussi hors-ligne via le Service Worker). */
async function exists(url) {
  try {
    const r = await fetch(url);
    if (r.body && r.body.cancel) r.body.cancel();
    return r.ok;
  } catch (e) { return false; }
}

async function loadFactory(url, opts) {
  if (opts.esm) {
    const mod = await import(/* @vite-ignore */ url);
    const f = mod.default || mod.createPS1Module || mod.Module;
    if (typeof f === 'function') return f;
  }
  // Glue "classique" : <script> qui définit une fonction globale
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = resolve; s.onerror = () => reject(new Error('Chargement du glue impossible'));
    document.head.appendChild(s);
  });
  if (typeof window[opts.global] !== 'function') throw new Error(`Glue invalide : window.${opts.global} absent`);
  return window[opts.global];
}

class Ps1WasmCore {
  constructor(ctx) {
    this.ctx = ctx;
    this.opts = Object.assign({}, DEFAULTS, (ctx.descriptor && ctx.descriptor.options) || {});
    this.M = null; this.fn = {}; this.hw = false; this.renderer = null; this.loop = null;
    this.memfsPath = null;
  }

  /* ----------------------------------------------------------- */
  /*  Étape 1 : instancier le module WASM                         */
  /* ----------------------------------------------------------- */
  async _instantiate(wantGL) {
    const ctx = this.ctx;
    const glueUrl = ctx.assetUrl(this.opts.glue);
    if (!(await exists(glueUrl))) {
      throw new Error('Cœur PS1 WASM introuvable (plugins/cores/ps1-wasm/core/ps1.js + ps1.wasm)');
    }
    let factory;
    try { factory = await loadFactory(glueUrl, this.opts); }
    catch (e) { throw new Error('Chargement du cœur WASM impossible : ' + (e && e.message || e)); }

    const cfg = {
      noInitialRun: true,
      locateFile: p => ctx.assetUrl(p),
      print: (...a) => ctx.log(...a),
      printErr: (...a) => console.warn('[ps1-wasm]', ...a)
    };
    if (wantGL) cfg.canvas = ctx.canvas;     // le cœur crée lui-même son contexte WebGL
    try { this.M = await factory(cfg); }
    catch (e) { throw new Error('Initialisation WASM impossible (ps1.wasm présent ?) : ' + (e && e.message || e)); }

    // Raccourcis typés vers l'ABI (les fonctions optionnelles peuvent manquer)
    const M = this.M, w = (name, ret, args) => (M['_' + name] ? M.cwrap(name, ret, args) : null);
    this.fn = {
      init: w('ps_init', 'number', ['string']), caps: w('ps_caps', 'number', []),
      load: w('ps_load', 'number', ['string']), run: w('ps_run_frame', null, ['number']),
      btn: w('ps_set_button', null, ['number', 'number']), axis: w('ps_set_axis', null, ['number', 'number']),
      opt: w('ps_set_option', null, ['string', 'number']), reset: w('ps_reset', null, []),
      shutdown: w('ps_shutdown', null, []),
      vptr: w('ps_video_ptr', 'number', []), vw: w('ps_video_width', 'number', []),
      vh: w('ps_video_height', 'number', []), vfmt: w('ps_video_format', 'number', []),
      vpitch: w('ps_video_pitch', 'number', []),
      fps: w('ps_fps', 'number', []), stat: w('ps_stat', 'number', ['number'])
    };
    for (const k of ['init', 'load', 'run']) {
      if (!this.fn[k]) throw new Error(`ABI incomplète : ps_${k === 'run' ? 'run_frame' : k} manquant`);
    }
  }

  /* ----------------------------------------------------------- */
  /*  Étape 2 : BIOS dans le FS virtuel                           */
  /* ----------------------------------------------------------- */
  async _installBios() {
    const FS = this.M.FS;
    try { FS.mkdir('/system'); } catch (e) {}
    for (const name of this.opts.bios) {
      const url = this.ctx.assetUrl(name);
      try {
        const r = await fetch(url, { cache: 'force-cache' });
        if (!r.ok) continue;
        FS.writeFile('/system/' + name, new Uint8Array(await r.arrayBuffer()));
        this.ctx.log('BIOS installé :', name);
        return true;
      } catch (e) {}
    }
    this.ctx.log('Aucun BIOS trouvé dans plugins/cores/ps1-wasm/bios/ (le cœur peut utiliser un BIOS HLE)');
    return false;
  }

  /* ----------------------------------------------------------- */
  /*  Étape 3 : donner le jeu au cœur sans saturer la RAM         */
  /* ----------------------------------------------------------- */
  async _mountRom(rom) {
    const M = this.M, caps = this.fn.caps ? this.fn.caps() : 0;

    // A) Zéro copie : le cœur lit directement dans OPFS (WasmFS + backend OPFS)
    if ((caps & 1) && rom.opfs) {
      const p = `/opfs/${rom.opfs.dir}/${rom.opfs.name}`;
      this.ctx.log('Lecture directe OPFS :', p);
      return p;
    }

    // B) Copie en flux vers MEMFS (blocs de 8 Mo, jamais le fichier entier côté JS)
    const maxMB = this.opts.maxMemfsMB;
    if (rom.size > maxMB * MB) {
      throw new Error(`Jeu trop volumineux (${(rom.size / MB).toFixed(0)} Mo) pour la mémoire du navigateur ` +
        `(limite ${maxMB} Mo). Compile le cœur avec WasmFS + OPFS pour la lecture directe.`);
    }
    const FS = M.FS;
    try { FS.mkdir('/rom'); } catch (e) {}
    const path = '/rom/' + rom.name.replace(/[^\w.\-]+/g, '_');
    const stream = FS.open(path, 'w+');
    const STEP = 8 * MB;
    let lastPct = -1;
    for (let off = 0; off < rom.size; off += STEP) {
      const chunk = await rom.readRange(off, Math.min(STEP, rom.size - off));
      FS.write(stream, chunk, 0, chunk.length, off);
      const pct = Math.floor(Math.min(1, (off + STEP) / rom.size) * 100);
      if (pct !== lastPct && pct % 20 === 0 && window.appUI) window.appUI.toast(`Préparation du jeu… ${pct}%`);
      lastPct = pct;
    }
    FS.close(stream);
    this.memfsPath = path;
    return path;
  }

  /* ----------------------------------------------------------- */
  /*  API du plugin                                               */
  /* ----------------------------------------------------------- */
  async load(rom) {
    await this._instantiate(false);
    const caps = this.fn.caps ? this.fn.caps() : 2;
    this.hw = !!(caps & 4) && !(caps & 2);
    if (this.hw) {
      // Cœur à rendu GL direct : il lui faut le canvas dès la création du module
      this.M = null;
      await this._instantiate(true);
    } else {
      this.renderer = await this.ctx.createRenderer();
    }

    await this._installBios();
    const rc = this.fn.init('/system');
    if (rc !== 0) throw new Error('ps_init a échoué (code ' + rc + ')');

    const path = await this._mountRom(rom);
    const lc = this.fn.load(path);
    if (lc !== 0) throw new Error('Format non supporté par le cœur (ps_load → ' + lc + ')');

    this._pushSettings(this.ctx.settings);
  }

  async start() {
    const fps = (this.fn.fps && this.fn.fps()) || 59.94;
    this.loop = this.ctx.createLoop({ fps, onFrame: skip => this._frame(skip) });
    this.loop.start();
  }

  _frame(skip) {
    this.fn.run(skip ? 1 : 0);
    if (skip || this.hw || !this.renderer) return;
    const f = this.fn, M = this.M;
    const ptr = f.vptr(), w = f.vw(), h = f.vh();
    if (!ptr || !w || !h) return;
    const fmt = f.vfmt ? f.vfmt() : 0;
    const pitch = f.vpitch ? f.vpitch() : 0;
    // HEAPU8 est relu à chaque trame : sa vue change si la mémoire WASM grandit
    if (fmt === 2) {
      const stride = pitch || w * 2;
      this.renderer.present({ width: w, height: h, format: 'rgb565', stride, data: new Uint16Array(M.HEAPU8.buffer, ptr, (stride * h) >> 1) });
    } else {
      const stride = pitch || w * 4;
      this.renderer.present({ width: w, height: h, format: fmt === 1 ? 'bgra' : 'rgba', stride, data: new Uint8Array(M.HEAPU8.buffer, ptr, stride * h) });
    }
  }

  /* Manette → ABI C */
  setInput(name, value, info) {
    if (!this.M) return;
    if (info.kind === 'button') this.fn.btn && this.fn.btn(info.index, value ? 1 : 0);
    else this.fn.axis && this.fn.axis(info.index, value);
  }

  applySettings(s) { this._pushSettings(s); }

  _pushSettings(s) {
    if (!this.fn.opt) return;
    const filter = { none: 0, smooth: 1, crt: 2 }[s.filter] || 0;
    this.fn.opt('scale', s.scale | 0);
    this.fn.opt('frameskip', s.frameskip | 0);
    this.fn.opt('filter', filter);
    this.fn.opt('show_fps', s.showFps ? 1 : 0);
  }

  getStats() {
    const out = {}, f = this.fn;
    if (this.M && this.M.HEAPU8) out.ram = Math.round(this.M.HEAPU8.length / MB);
    if (f.stat) { try { out.cpu = f.stat(0) || undefined; out.vram = f.stat(2) || undefined; const r = f.stat(1); if (r) out.ram = r; } catch (e) {} }
    return out;
  }

  pause() {}
  resume() {}

  stop() { this.loop && this.loop.stop(); }

  dispose() {
    this.loop && this.loop.stop();
    try { this.fn.shutdown && this.fn.shutdown(); } catch (e) {}
    try { this.memfsPath && this.M && this.M.FS.unlink(this.memfsPath); } catch (e) {}
    try { this.M && this.M.PThread && this.M.PThread.terminateAllThreads && this.M.PThread.terminateAllThreads(); } catch (e) {}
    this.M = null; this.fn = {}; this.renderer = null;
  }
}

export default {
  id: 'ps1-wasm',
  async create(ctx) { return new Ps1WasmCore(ctx); }
};
