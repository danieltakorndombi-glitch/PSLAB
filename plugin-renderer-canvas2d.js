/**
 * Moteur de rendu Canvas 2D – filet de sécurité (aucun WebGL/WebGPU requis).
 * Même contrat que webgl2.js (voir ce fichier).
 */
class Canvas2DPresenter {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.scale = opts.scale || 1;
    this.filter = opts.filter || 'none';
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.ctx) throw new Error('Canvas 2D indisponible');
    this.info = { api: 'canvas2d', renderer: 'software' };
    this.img = null; this.tmp = null; this.last = null;
  }
  setFilter(f) { this.filter = f || 'none'; if (this.last) this.present(this.last); }
  setScale(n) { this.scale = Math.max(1, Math.min(4, n | 0 || 1)); if (this.last) this.present(this.last); }

  present(frame) {
    if (!frame || !frame.width || !frame.height) return;
    this.last = frame;
    const { width: w, height: h } = frame;
    const ow = Math.round(w * this.scale), oh = Math.round(h * this.scale);
    if (this.canvas.width !== ow || this.canvas.height !== oh) { this.canvas.width = ow; this.canvas.height = oh; }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = this.filter !== 'none';

    let src = frame.source;
    if (!src) {
      if (!this.img || this.img.width !== w || this.img.height !== h) this.img = new ImageData(w, h);
      const d = this.img.data, s = frame.data, fmt = frame.format || 'rgba';
      if (fmt === 'rgba') d.set(s.subarray ? s.subarray(0, d.length) : s);
      else if (fmt === 'bgra') { for (let i = 0; i < d.length; i += 4) { d[i] = s[i + 2]; d[i + 1] = s[i + 1]; d[i + 2] = s[i]; d[i + 3] = 255; } }
      else if (fmt === 'rgb565') {
        for (let i = 0, j = 0; j < d.length; i++, j += 4) {
          const p = s[i];
          d[j] = ((p >> 11) & 31) * 255 / 31; d[j + 1] = ((p >> 5) & 63) * 255 / 63; d[j + 2] = (p & 31) * 255 / 31; d[j + 3] = 255;
        }
      }
      if (!this.tmp) this.tmp = document.createElement('canvas');
      if (this.tmp.width !== w || this.tmp.height !== h) { this.tmp.width = w; this.tmp.height = h; }
      this.tmp.getContext('2d').putImageData(this.img, 0, 0);
      src = this.tmp;
    }
    ctx.drawImage(src, 0, 0, ow, oh);
    if (this.filter === 'crt') {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      const step = Math.max(2, Math.round(this.scale * 2));
      for (let y = 0; y < oh; y += step) ctx.fillRect(0, y, ow, Math.max(1, step / 2));
    }
  }
  dispose() { this.ctx = null; this.img = null; this.tmp = null; this.last = null; }
}

export default {
  id: 'canvas2d',
  async create({ canvas, scale, filter }) { return new Canvas2DPresenter(canvas, { scale, filter }); }
};
