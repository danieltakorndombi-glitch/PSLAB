/**
 * Moteur de rendu WebGPU – plugin "renderer"
 * Même contrat que webgl2.js. Chargé uniquement si navigator.gpu existe.
 * Formats gérés : 'rgba', 'bgra' (XRGB8888), 'rgb565' (converti côté CPU), ou `source` (canvas/bitmap).
 */
const WGSL = `
struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };
struct U { src : vec2f, mode : f32, bgra : f32 };
@group(0) @binding(0) var smp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : U;

@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o : VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(in : VOut) -> @location(0) vec4f {
  let c = textureSample(tex, smp, in.uv);
  var col = select(c.rgb, c.bgr, u.bgra > 0.5);
  if (u.mode > 0.5) {
    let line = 0.80 + 0.20 * sin(in.uv.y * u.src.y * 6.2831853);
    let d = in.uv - vec2f(0.5);
    col = col * line * (1.0 - dot(d, d) * 0.55);
  }
  return vec4f(col, 1.0);
}`;

class WebGPUPresenter {
  constructor(canvas, opts) {
    this.canvas = canvas; this.scale = opts.scale || 1; this.filter = opts.filter || 'none';
    this.info = { api: 'webgpu', renderer: '' };
    this.tex = null; this.texKey = ''; this.last = null; this.outW = 0; this.outH = 0; this.rgba = null;
  }

  async init() {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Aucun adaptateur WebGPU');
    this.device = await adapter.requestDevice();
    this.ctx = this.canvas.getContext('webgpu');
    if (!this.ctx) throw new Error('Contexte WebGPU indisponible');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    const mod = this.device.createShaderModule({ code: WGSL });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' }
    });
    this.samplers = {
      nearest: this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }),
      linear: this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    };
    this.ubuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.info.renderer = (adapter.info && (adapter.info.description || adapter.info.vendor)) || 'webgpu';
  }

  setFilter(f) { this.filter = f || 'none'; if (this.last) this.present(this.last); }
  setScale(n) { this.scale = Math.max(1, Math.min(4, n | 0 || 1)); this.outW = 0; if (this.last) this.present(this.last); }

  present(frame) {
    if (!frame || !frame.width || !frame.height || !this.device) return;
    this.last = frame;
    const { width: w, height: h } = frame;
    const ow = Math.round(w * this.scale), oh = Math.round(h * this.scale);
    if (ow !== this.outW || oh !== this.outH) { this.canvas.width = ow; this.canvas.height = oh; this.outW = ow; this.outH = oh; }

    const key = w + 'x' + h;
    if (key !== this.texKey) {
      this.tex && this.tex.destroy();
      this.tex = this.device.createTexture({
        size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      this.texKey = key;
      this.bind = null;
    }

    const fmt = frame.format || 'rgba';
    if (frame.source) {
      this.device.queue.copyExternalImageToTexture({ source: frame.source }, { texture: this.tex }, [w, h]);
    } else {
      let bytes = frame.data;
      if (fmt === 'rgb565') {
        if (!this.rgba || this.rgba.length !== w * h * 4) this.rgba = new Uint8Array(w * h * 4);
        const s = frame.data, d = this.rgba;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
          const p = s[i];
          d[j] = ((p >> 11) & 31) * 255 / 31; d[j + 1] = ((p >> 5) & 63) * 255 / 63; d[j + 2] = (p & 31) * 255 / 31; d[j + 3] = 255;
        }
        bytes = d;
      }
      this.device.queue.writeTexture({ texture: this.tex }, bytes, { bytesPerRow: frame.stride || w * 4, rowsPerImage: h }, [w, h]);
    }

    this.device.queue.writeBuffer(this.ubuf, 0, new Float32Array([w, h, this.filter === 'crt' ? 1 : 0, fmt === 'bgra' ? 1 : 0]));
    const sampler = this.filter === 'none' ? this.samplers.nearest : this.samplers.linear;
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: this.tex.createView() },
        { binding: 2, resource: { buffer: this.ubuf } }
      ]
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
    });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  dispose() {
    try { this.tex && this.tex.destroy(); this.ubuf && this.ubuf.destroy(); this.ctx && this.ctx.unconfigure(); this.device && this.device.destroy(); } catch (e) {}
    this.device = null; this.last = null;
  }
}

export default {
  id: 'webgpu',
  async create({ canvas, scale, filter }) {
    const p = new WebGPUPresenter(canvas, { scale, filter });
    await p.init();
    return p;
  }
};
