/**
 * Cœur "Diagnostic" – plugin core SANS WebAssembly
 * ------------------------------------------------------------
 * Sert de moteur de repli tant qu'aucun vrai cœur WASM n'est installé, et de
 * banc d'essai de toute la chaîne technique :
 *
 *   ROM (OPFS/IndexedDB) ──readRange()──▶ analyse de l'en-tête (ISO / BIN / CHD / PBP)
 *   Manette virtuelle ────setInput()────▶ état affiché en direct
 *   Boucle de cadence ──▶ framebuffer logiciel ──▶ présentateur WebGL2/WebGPU ──▶ <canvas id="game-canvas">
 *
 * Il N'ÉMULE PAS de PlayStation : il prouve que chaque maillon est branché.
 * Copier ce fichier est le meilleur point de départ pour écrire un autre plugin.
 */

const W = 320, H = 224;   // résolution "logique" (ratio du canvas 640×448)
const ascii = (u8, from, to) => String.fromCharCode(...u8.subarray(from, to));

function find(u8, text) {
  const n = text.length;
  outer: for (let i = 0; i <= u8.length - n; i++) {
    for (let j = 0; j < n; j++) if (u8[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Lit seulement quelques Ko du jeu : jamais le fichier entier. */
async function inspect(rom) {
  const info = { format: 'Inconnu', sectorSize: 0, volume: '', ps1: false, sizeMB: (rom.size / 1048576).toFixed(1) };
  try {
    const head = await rom.readRange(0, 4096);
    if (ascii(head, 0, 8) === 'MComprHD') { info.format = 'CHD (compressé)'; return info; }
    if (head[0] === 0 && ascii(head, 1, 4) === 'PBP') { info.format = 'PBP (EBOOT)'; return info; }
    if (/\.cue$/i.test(rom.name)) { info.format = 'CUE (feuille de pistes)'; return info; }

    for (const [size, off] of [[2048, 0], [2352, 24], [2352, 16]]) {
      const pvd = await rom.readRange(16 * size + off, 2048);
      if (pvd.length >= 80 && ascii(pvd, 1, 6) === 'CD001') {
        info.sectorSize = size;
        info.format = size === 2048 ? 'ISO 9660 (2048 o/secteur)' : 'BIN brut (2352 o/secteur)';
        info.volume = ascii(pvd, 40, 72).replace(/[^\x20-\x7e]/g, '').trim();
        break;
      }
    }
    const sys = await rom.readRange(0, 16 * (info.sectorSize || 2352));
    info.ps1 = find(sys, 'Licensed by Sony Computer Entertainment') >= 0;
  } catch (e) { info.error = e.message; }
  return info;
}

class DemoCore {
  constructor(ctx) {
    this.ctx = ctx;
    this.settings = ctx.settings;
    this.frame = 0;
    this.fpsAcc = { n: 0, t: performance.now(), fps: 0 };
    this.info = null;
  }

  async load(rom) {
    this.rom = rom;
    this.renderer = await this.ctx.createRenderer();
    this.fb = document.createElement('canvas');
    this.fb.width = W; this.fb.height = H;
    this.g = this.fb.getContext('2d');
    this.info = await inspect(rom);
    this.ctx.log('ROM analysée :', this.info);
    this._draw(0);                 // première image immédiatement
    this.renderer.present({ source: this.fb, width: W, height: H });
  }

  async start() {
    this.loop = this.ctx.createLoop({ fps: 60, onFrame: skip => this._tick(skip) });
    this.loop.start();
  }

  _tick(skip) {
    this.frame++;
    this.fpsAcc.n++;
    const now = performance.now();
    if (now - this.fpsAcc.t >= 1000) { this.fpsAcc.fps = this.fpsAcc.n; this.fpsAcc.n = 0; this.fpsAcc.t = now; }
    if (skip) return;
    this._draw(this.frame);
    this.renderer.present({ source: this.fb, width: W, height: H });
  }

  applySettings(s) { this.settings = s; }
  dispose() { this.loop && this.loop.stop(); this.fb = null; this.g = null; this.renderer = null; }

  /* ---------------------------- dessin ---------------------------- */
  _draw(f) {
    const g = this.g, inp = this.ctx.input, B = this.ctx.BUTTONS;
    const t = f / 60;

    // fond animé
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, `hsl(${215 + Math.sin(t * 0.5) * 12},55%,11%)`);
    grad.addColorStop(1, '#05060c');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    // bandeau
    g.fillStyle = '#0070d1'; g.fillRect(0, 0, W, 22);
    g.fillStyle = '#fff'; g.font = 'bold 11px sans-serif'; g.textBaseline = 'middle';
    g.fillText('MODE DIAGNOSTIC — aucun cœur WASM actif', 8, 11);

    // infos ROM
    const i = this.info || {};
    g.font = '10px monospace'; g.fillStyle = '#cfd6ff';
    const name = this.rom.name.length > 40 ? this.rom.name.slice(0, 37) + '…' : this.rom.name;
    const lines = [
      `Fichier  : ${name}`,
      `Taille   : ${i.sizeMB} Mo (lue par blocs, jamais en RAM)`,
      `Format   : ${i.format}`,
      i.volume ? `Volume   : ${i.volume}` : null,
      `PlayStation : ${i.ps1 ? 'signature Sony détectée' : 'non détectée'}`
    ].filter(Boolean);
    lines.forEach((l, k) => g.fillText(l, 8, 36 + k * 13));

    const notes = (this.ctx.fallbackNotes || []).filter(n => !n.skip);
    if (notes.length) {
      // Pourquoi le vrai moteur n'a pas démarré (visible sur une capture d'écran)
      g.font = '9px monospace'; g.fillStyle = '#ffb454';
      const txt = `${notes[0].name} : ${notes[0].msg}`;
      const rows = [];
      let cur = '';
      txt.split(' ').forEach(w => { if ((cur + ' ' + w).trim().length > 54) { rows.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); });
      if (cur) rows.push(cur);
      rows.slice(0, 3).forEach((l, k) => g.fillText(rows.length > 3 && k === 2 ? l.slice(0, 51) + '…' : l, 8, 102 + k * 11));
    } else {
      g.fillStyle = '#8c93b8';
      g.fillText('Installe un cœur dans plugins/cores/ et déclare-le', 8, 112);
      g.fillText('dans registry.json pour émuler pour de vrai.', 8, 124);
    }
    // État de l'environnement
    const sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    g.font = '8px monospace'; g.fillStyle = '#5e6690';
    g.fillText(`isolation ${window.crossOriginIsolated ? 'oui' : 'NON'} · SAB ${typeof SharedArrayBuffer !== 'undefined' ? 'oui' : 'NON'} · SW ${sw ? 'oui' : 'NON'}`, 8, 134);

    // ---------- manette ----------
    const lit = idx => inp.buttons[idx] > 0;
    const pad = (x, y, w, h, on, label) => {
      g.fillStyle = on ? '#00a0ff' : '#1f2433'; g.fillRect(x, y, w, h);
      g.strokeStyle = '#3a4160'; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
      g.fillStyle = on ? '#fff' : '#8c93b8'; g.font = '8px sans-serif'; g.textAlign = 'center';
      g.fillText(label, x + w / 2, y + h / 2 + 0.5); g.textAlign = 'left';
    };
    // gâchettes
    pad(14, 140, 30, 12, lit(B.l2), 'L2'); pad(14, 154, 30, 12, lit(B.l1), 'L1');
    pad(W - 44, 140, 30, 12, lit(B.r2), 'R2'); pad(W - 44, 154, 30, 12, lit(B.r1), 'R1');
    // croix directionnelle
    pad(62, 144, 14, 14, lit(B.up), '▲'); pad(62, 172, 14, 14, lit(B.down), '▼');
    pad(48, 158, 14, 14, lit(B.left), '◀'); pad(76, 158, 14, 14, lit(B.right), '▶');
    // boutons d'action
    pad(W - 76, 144, 14, 14, lit(B.triangle), '△'); pad(W - 76, 172, 14, 14, lit(B.cross), '✕');
    pad(W - 90, 158, 14, 14, lit(B.square), '□'); pad(W - 62, 158, 14, 14, lit(B.circle), '○');
    // système
    pad(W / 2 - 50, 168, 30, 11, lit(B.share), 'SHARE'); pad(W / 2 - 15, 168, 30, 11, lit(B.home), 'PS');
    pad(W / 2 + 20, 168, 30, 11, lit(B.options), 'OPT');
    // sticks
    const stick = (cx, cy, ax, ay) => {
      g.strokeStyle = '#3a4160'; g.beginPath(); g.arc(cx, cy, 16, 0, 6.2832); g.stroke();
      g.fillStyle = (ax || ay) ? '#00a0ff' : '#2a3150';
      g.beginPath(); g.arc(cx + ax * 12, cy + ay * 12, 6, 0, 6.2832); g.fill();
    };
    stick(W / 2 - 34, 202, inp.axes[0], inp.axes[1]);
    stick(W / 2 + 34, 202, inp.axes[2], inp.axes[3]);

    g.fillStyle = '#5e6690'; g.font = '8px monospace'; g.textAlign = 'right'; g.fillText('diag v2', W - 8, 134); g.textAlign = 'left';

    // compteur de trames + FPS
    g.fillStyle = '#5e6690'; g.font = '9px monospace';
    g.fillText(`trame ${f}`, 8, H - 8);
    if (this.settings.showFps) {
      g.fillStyle = '#00c853'; g.textAlign = 'right';
      g.fillText(`${this.fpsAcc.fps} FPS • ${this.renderer.info.api}`, W - 8, H - 8);
      g.textAlign = 'left';
    }
  }
}

export default {
  id: 'demo',
  async create(ctx) { return new DemoCore(ctx); }
};
