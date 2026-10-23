/* ===== gamepad.js ===== */
/**
 * Manette virtuelle plein écran – vrais boutons, repositionnables.
 * Positions en % de l'écran, mémorisées séparément en paysage / portrait.
 */
const GP_KEY = 'ps-gp-layout-v1';
const GP_DEFAULTS = {
  landscape: { l2:[8,9,1], l1:[8,22,1], r2:[92,9,1], r1:[92,22,1], dpad:[11,46,1], 'stick-left':[24,78,1],
               face:[89,46,1], 'stick-right':[76,78,1], share:[39,91,1], home:[50,91,1], options:[61,91,1] },
  portrait:  { l2:[13,55,1], l1:[13,62,1], r2:[87,55,1], r1:[87,62,1], dpad:[22,73,1], 'stick-left':[22,89,1],
               face:[78,73,1], 'stick-right':[78,89,1], share:[50,64,1], home:[50,72,1], options:[50,80,1] }
};

class VirtualGamepad {
  constructor() {
    this.active = false; this.editing = false; this.selected = null;
    this.hapticEnabled = true; this.sensitivity = 1.0;
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    this.buttons = {};
    this.layout = JSON.parse(JSON.stringify(GP_DEFAULTS));
    try {
      const saved = JSON.parse(localStorage.getItem(GP_KEY) || '{}');
      for (const o of ['landscape', 'portrait'])
        for (const id in GP_DEFAULTS[o])
          if (saved[o] && Array.isArray(saved[o][id]) && saved[o][id].length === 3) this.layout[o][id] = saved[o][id];
    } catch (e) {}
  }

  init() {
    this.root = document.getElementById('gamepad');
    this.root.addEventListener('contextmenu', e => e.preventDefault());
    this.bindEdit(); this.bindSticks(); this.bindButtons(); this.bindBar();
    window.addEventListener('resize', () => this.applyLayout());
    this.applyLayout();
  }

  orient() { return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape'; }
  cur() { return this.layout[this.orient()]; }
  save() { try { localStorage.setItem(GP_KEY, JSON.stringify(this.layout)); } catch (e) {} }

  applyLayout() {
    const lay = this.cur();
    this.root.querySelectorAll('.ctl').forEach(el => {
      const v = lay[el.dataset.ctl];
      el.style.setProperty('--x', v[0]); el.style.setProperty('--y', v[1]); el.style.setProperty('--s', v[2]);
    });
  }

  // ---------- MODE AJUSTEMENT ----------
  bindEdit() {
    let drag = null;
    this.root.addEventListener('pointerdown', e => {
      if (!this.editing) return;
      const el = e.target.closest('.ctl');
      if (!el) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.select(el);
      const v = this.cur()[el.dataset.ctl];
      drag = { el, v, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: v[0], oy: v[1] };
      el.setPointerCapture(e.pointerId);
    }, true);
    this.root.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const c = (n) => Math.max(3, Math.min(97, n));
      drag.v[0] = +c(drag.ox + (e.clientX - drag.sx) / innerWidth * 100).toFixed(1);
      drag.v[1] = +c(drag.oy + (e.clientY - drag.sy) / innerHeight * 100).toFixed(1);
      this.applyLayout();
    });
    const end = e => { if (drag && e.pointerId === drag.id) { drag = null; this.save(); } };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
  }

  select(el) {
    this.root.querySelectorAll('.ctl.sel').forEach(n => n.classList.remove('sel'));
    this.selected = el; el.classList.add('sel');
    document.getElementById('gp-size').value = this.cur()[el.dataset.ctl][2];
  }

  setEditing(on) {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    document.getElementById('gp-edit').textContent = on ? 'Terminé' : 'Ajuster';
    if (!on) { this.selected = null; this.root.querySelectorAll('.sel').forEach(n => n.classList.remove('sel')); this.save(); }
  }

  bindBar() {
    document.getElementById('gp-edit').addEventListener('click', () => this.setEditing(!this.editing));
    document.getElementById('gp-close').addEventListener('click', () => this.hide());
    document.getElementById('gp-reset').addEventListener('click', () => {
      this.layout[this.orient()] = JSON.parse(JSON.stringify(GP_DEFAULTS[this.orient()]));
      this.applyLayout(); this.save();
    });
    document.getElementById('gp-size').addEventListener('input', e => {
      if (!this.selected) return;
      this.cur()[this.selected.dataset.ctl][2] = parseFloat(e.target.value);
      this.applyLayout();
    });
    document.getElementById('gp-size').addEventListener('change', () => this.save());
  }

  // ---------- STICKS ----------
  bindSticks() {
    ['left', 'right'].forEach(side => {
      const zone = document.getElementById(`stick-${side}`);
      const knob = document.getElementById(`knob-${side}`);
      let pid = null;
      zone.addEventListener('pointerdown', e => {
        if (this.editing || pid !== null) return;
        pid = e.pointerId; zone.setPointerCapture(pid);
        knob.classList.add('active'); this.updateStick(side, zone, knob, e); this.vibrate(10);
      });
      zone.addEventListener('pointermove', e => { if (e.pointerId === pid) this.updateStick(side, zone, knob, e); });
      const end = e => {
        if (e.pointerId !== pid) return;
        pid = null; knob.classList.remove('active');
        knob.style.transform = 'translate(-50%, -50%)';
        this.sticks[side].x = 0; this.sticks[side].y = 0;
        window.EmulatorCore.setInput(`${side}_x`, 0); window.EmulatorCore.setInput(`${side}_y`, 0);
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
    });
  }

  updateStick(side, zone, knob, p) {
    const r = zone.getBoundingClientRect();
    const sc = r.width / zone.offsetWidth || 1;          // échelle appliquée au contrôle
    const maxR = zone.offsetWidth * 0.28;                 // rayon max en px locaux
    let dx = (p.clientX - (r.left + r.width / 2)) / sc * this.sensitivity;
    let dy = (p.clientY - (r.top + r.height / 2)) / sc * this.sensitivity;
    const d = Math.hypot(dx, dy);
    if (d > maxR) { dx = dx / d * maxR; dy = dy / d * maxR; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.sticks[side].x = dx / maxR; this.sticks[side].y = dy / maxR;
    window.EmulatorCore.setInput(`${side}_x`, dx / maxR);
    window.EmulatorCore.setInput(`${side}_y`, dy / maxR);
  }

  // ---------- BOUTONS ----------
  bindButtons() {
    this.root.querySelectorAll('[data-btn]').forEach(btn => {
      const name = btn.dataset.btn; let pid = null;
      btn.addEventListener('pointerdown', e => {
        if (pid !== null) return;
        pid = e.pointerId; btn.setPointerCapture(pid); btn.classList.add('active');
        this.buttons[name] = 1; window.EmulatorCore.setInput(name, 1); this.vibrate(15);
      });
      const up = e => {
        if (e.pointerId !== pid) return;
        pid = null; btn.classList.remove('active');
        this.buttons[name] = 0; window.EmulatorCore.setInput(name, 0);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });
  }

  vibrate(ms = 15) { if (this.hapticEnabled && navigator.vibrate) navigator.vibrate(ms); }
  setHaptic(v) { this.hapticEnabled = v; }
  setSensitivity(v) { this.sensitivity = v; }

  show() {
    this.root.classList.remove('hidden'); this.active = true; this.applyLayout();
    document.getElementById('toggle-gamepad')?.classList.add('on');
  }
  hide() {
    this.setEditing(false);
    this.root.classList.add('hidden'); this.active = false;
    document.getElementById('toggle-gamepad')?.classList.remove('on');
  }
  toggle() { this.active ? this.hide() : this.show(); }
}

window.virtualGamepad = new VirtualGamepad();
