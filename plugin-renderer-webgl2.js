/**
 * Moteur de rendu WebGL2 – plugin "renderer"
 * ------------------------------------------------------------
 * Affiche sur <canvas id="game-canvas"> les images produites par un cœur
 * "logiciel" (framebuffer CPU : RGBA, XRGB8888 ou RGB565).
 *
 * Contrat renderer :
 *   create({ canvas, scale, filter }) → présentateur
 *   présentateur :
 *     present(frame)   frame = { width, height, format, data?, source?, stride? }
 *                        format : 'rgba' | 'bgra' (XRGB8888) | 'rgb565'
 *                        data   : Uint8Array | Uint8ClampedArray | Uint16Array
 *                        source : CanvasImageSource (OffscreenCanvas, ImageBitmap…) – alternative à data
 *                        stride : octets par ligne (optionnel)
 *     setFilter('none' | 'smooth' | 'crt')
 *     setScale(n)      multiplicateur de résolution de sortie (1–4)
 *     dispose()
 *     info             { api, renderer }
 *
 * Les cœurs qui rendent déjà en WebGL (Emscripten + OpenGL ES) n'ont pas
 * besoin de renderer : ils utilisent directement le canvas.
 */

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform float uMode;   // 0 = brut, 1 = CRT
uniform float uBgra;   // 1 = XRGB8888 (B,G,R,X en mémoire)
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 col = uBgra > 0.5 ? c.bgr : c.rgb;
  if (uMode > 0.5) {
    float line = 0.80 + 0.20 * sin(vUv.y * uSrcSize.y * 6.2831853);
    vec2 d = vUv - 0.5;
    float vig = 1.0 - dot(d, d) * 0.55;
    col *= line * vig;
  }
  outColor = vec4(col, 1.0);
}`;

class WebGL2Presenter {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.scale = opts.scale || 1;
    this.filter = opts.filter || 'none';
    this.info = { api: 'webgl2', renderer: '' };
    this.tex = null; this.texW = 0; this.texH = 0; this.texFmt = '';
    this.outW = 0; this.outH = 0;
    this.last = null;

    this._onLost = e => { e.preventDefault(); this.lost = true; };
    this._onRestored = () => { this.lost = false; this._initGL(); if (this.last) this.present(this.last); };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
    this._initGL();
  }

  _initGL() {
    const gl = this.gl || this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true
    });
    if (!gl) throw new Error('WebGL2 indisponible');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader : ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link : ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {
      tex: gl.getUniformLocation(prog, 'uTex'),
      size: gl.getUniformLocation(prog, 'uSrcSize'),
      mode: gl.getUniformLocation(prog, 'uMode'),
      bgra: gl.getUniformLocation(prog, 'uBgra')
    };
    this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    this.texW = this.texH = 0; this.texFmt = '';
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.info.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) {}
  }

  setFilter(f) { this.filter = f || 'none'; if (this.last) this.present(this.last); }
  setScale(n) { this.scale = Math.max(1, Math.min(4, n | 0 || 1)); this.outW = 0; if (this.last) this.present(this.last); }

  _resizeOutput(w, h) {
    const max = Math.min(4096, this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) || 4096);
    const ow = Math.min(max, Math.round(w * this.scale));
    const oh = Math.min(max, Math.round(h * this.scale));
    if (ow !== this.outW || oh !== this.outH) {
      this.canvas.width = ow; this.canvas.height = oh;
      this.outW = ow; this.outH = oh;
    }
  }

  present(frame) {
    if (this.lost || !frame) return;
    const gl = this.gl;
    const { width: w, height: h } = frame;
    if (!w || !h) return;
    this.last = frame;

    this._resizeOutput(w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const smooth = this.filter !== 'none';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let fmt = frame.format || 'rgba';
    let ifmt = gl.RGBA8, f = gl.RGBA, type = gl.UNSIGNED_BYTE, bpp = 4;
    if (frame.source) { fmt = 'source'; }
    else if (fmt === 'rgb565') { ifmt = gl.RGB565; f = gl.RGB; type = gl.UNSIGNED_SHORT_5_6_5; bpp = 2; }

    const key = `${fmt}:${w}x${h}`;
    const realloc = key !== this.texFmt;

    if (frame.source) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.source);
    } else {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, frame.stride ? Math.floor(frame.stride / bpp) : 0);
      if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, f, type, frame.data);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, f, type, frame.data);
    }
    this.texFmt = key;

    gl.viewport(0, 0, this.outW, this.outH);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.tex, 0);
    gl.uniform2f(this.u.size, w, h);
    gl.uniform1f(this.u.mode, this.filter === 'crt' ? 1 : 0);
    gl.uniform1f(this.u.bgra, fmt === 'bgra' ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    try {
      const gl = this.gl;
      gl.deleteTexture(this.tex); gl.deleteProgram(this.prog); gl.deleteVertexArray(this.vao);
      const lose = gl.getExtension('WEBGL_lose_context');
      lose && lose.loseContext();
    } catch (e) {}
    this.gl = null; this.last = null;
  }
}

export default {
  id: 'webgl2',
  async create({ canvas, scale, filter }) {
    return new WebGL2Presenter(canvas, { scale, filter });
  }
};
