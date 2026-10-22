/**
 * Virtual Touch Gamepad – optimisé iOS
 * Gère sticks analogiques + boutons + retour haptique
 */

class VirtualGamepad {
  constructor() {
    this.active = false;
    this.hapticEnabled = true;
    this.sensitivity = 1.0;

    this.sticks = {
      left:  { x: 0, y: 0, active: false },
      right: { x: 0, y: 0, active: false }
    };

    this.buttons = {};
  }

  init() {
    this.bindSticks();
    this.bindButtons();
    this.bindShoulders();
  }

  // ---------- STICKS ----------
  bindSticks() {
    ['left', 'right'].forEach(side => {
      const zone = document.getElementById(`stick-${side}`);
      const knob = document.getElementById(`knob-${side}`);
      if (!zone || !knob) return;

      const base = zone.querySelector('.stick-base');
      let trackingId = null;

      const getPoint = (e) => {
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX, y: t.clientY };
      };

      const onStart = (e) => {
        e.preventDefault();
        trackingId = e.touches ? e.touches[0].identifier : 'mouse';
        this.sticks[side].active = true;
        knob.classList.add('active');
        this.updateStick(side, zone, knob, getPoint(e));
        this.vibrate(10);
      };

      const onMove = (e) => {
        if (!this.sticks[side].active) return;
        e.preventDefault();
        // multi-touch safe
        if (e.touches) {
          const touch = Array.from(e.touches).find(t => t.identifier === trackingId);
          if (!touch) return;
          this.updateStick(side, zone, knob, { x: touch.clientX, y: touch.clientY });
        } else {
          this.updateStick(side, zone, knob, getPoint(e));
        }
      };

      const onEnd = (e) => {
        if (!this.sticks[side].active) return;
        this.sticks[side].active = false;
        this.sticks[side].x = 0;
        this.sticks[side].y = 0;
        knob.style.transform = 'translate(-50%, -50%)';
        knob.classList.remove('active');
        trackingId = null;

        // Envoyer au core
        window.EmulatorCore.setInput(`${side}_x`, 0);
        window.EmulatorCore.setInput(`${side}_y`, 0);
      };

      zone.addEventListener('touchstart', onStart, { passive: false });
      zone.addEventListener('touchmove', onMove, { passive: false });
      zone.addEventListener('touchend', onEnd);
      zone.addEventListener('touchcancel', onEnd);

      // souris (debug desktop)
      zone.addEventListener('mousedown', onStart);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
    });
  }

  updateStick(side, zone, knob, point) {
    const rect = zone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = rect.width / 2 - 24; // marge pour le knob

    let dx = (point.x - centerX) * this.sensitivity;
    let dy = (point.y - centerY) * this.sensitivity;

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    // Position visuelle
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // Normaliser -1 → 1
    const nx = dx / maxRadius;
    const ny = dy / maxRadius;

    this.sticks[side].x = nx;
    this.sticks[side].y = ny;

    window.EmulatorCore.setInput(`${side}_x`, nx);
    window.EmulatorCore.setInput(`${side}_y`, ny);
  }

  // ---------- BOUTONS (face + dpad + system) ----------
  bindButtons() {
    const allBtns = document.querySelectorAll('[data-btn]');
    allBtns.forEach(btn => {
      const name = btn.dataset.btn;

      const press = (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.add('active');
        this.buttons[name] = 1;
        window.EmulatorCore.setInput(name, 1);
        this.vibrate(15);
      };

      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        this.buttons[name] = 0;
        window.EmulatorCore.setInput(name, 0);
      };

      btn.addEventListener('touchstart', press, { passive: false });
      btn.addEventListener('touchend', release);
      btn.addEventListener('touchcancel', release);
      btn.addEventListener('mousedown', press);
      btn.addEventListener('mouseup', release);
      btn.addEventListener('mouseleave', release);
    });
  }

  bindShoulders() {
    // déjà couvert par data-btn
  }

  vibrate(ms = 15) {
    if (this.hapticEnabled && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  }

  setHaptic(enabled) {
    this.hapticEnabled = enabled;
  }

  setSensitivity(value) {
    this.sensitivity = value;
  }

  show() {
    document.getElementById('gamepad').classList.remove('hidden');
    this.active = true;
  }

  hide() {
    document.getElementById('gamepad').classList.add('hidden');
    this.active = false;
  }

  toggle() {
    this.active ? this.hide() : this.show();
  }
}

window.virtualGamepad = new VirtualGamepad();
