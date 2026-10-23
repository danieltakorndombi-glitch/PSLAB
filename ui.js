/* ===== ui.js ===== */
/**
 * UI Controller – navigation entre vues + toasts + stats
 */

class AppUI {
  constructor() {
    this.currentView = 'home';
  }

  init() {
    // Navigation
    document.getElementById('btn-library')?.addEventListener('click', () => this.showView('library'));
    document.getElementById('btn-settings')?.addEventListener('click', () => this.showView('settings'));
    document.getElementById('btn-show-gamepad')?.addEventListener('click', () => {
      window.virtualGamepad.toggle();
    });
    document.getElementById('toggle-gamepad')?.addEventListener('click', () => {
      window.virtualGamepad.toggle();
    });
    document.getElementById('btn-stop-game')?.addEventListener('click', () => {
      window.EmulatorCore.stop();
      document.getElementById('game-overlay').classList.remove('hidden');
      document.getElementById('game-status').textContent = 'Aucun jeu en cours';
      this.showView('home');
      window.virtualGamepad.hide();
    });

    // Settings → core
    this.bindSettings();

    // Sample games
    this.renderSampleGames();

    // Stats loop
    this.startStatsLoop();
  }

  showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${name}`);
    if (target) {
      target.classList.add('active');
      this.currentView = name;
    }

    // Si on quitte le jeu, on arrête (et on libère le moteur, même s'il était en pause)
    if (name !== 'game' && (window.EmulatorCore.isRunning || window.EmulatorCore.state === 'paused')) {
      window.EmulatorCore.stop();
    }
  }

  toast(message, type = '', ms = 2800) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast ' + type;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, ms);
  }

  bindSettings() {
    const scale = document.getElementById('setting-scale');
    const frameskip = document.getElementById('setting-frameskip');
    const filter = document.getElementById('setting-filter');
    const sensitivity = document.getElementById('setting-sensitivity');
    const haptic = document.getElementById('setting-haptic');
    const showFps = document.getElementById('setting-show-fps');

    const apply = () => {
      const settings = {
        scale: parseInt(scale?.value || 2, 10),
        frameskip: parseInt(frameskip?.value || 0, 10),
        filter: filter?.value || 'none',
        sensitivity: parseFloat(sensitivity?.value || 1),
        haptic: haptic?.checked ?? true,
        showFps: showFps?.checked ?? true
      };
      window.EmulatorCore.applySettings(settings);
      window.virtualGamepad.setSensitivity(settings.sensitivity);
      window.virtualGamepad.setHaptic(settings.haptic);
    };

    [scale, frameskip, filter, sensitivity, haptic, showFps].forEach(el => {
      el?.addEventListener('change', apply);
      el?.addEventListener('input', apply);
    });

    // Transmet une première fois les valeurs affichées au moteur (échelle, filtre…)
    apply();
  }

  renderSampleGames() {
    const container = document.getElementById('sample-games');
    if (!container) return;

    const samples = [
      { title: 'Demo Racing', meta: 'PS2 • Simulation', icon: '🏎️' },
      { title: 'Adventure Quest', meta: 'PS2 • Demo', icon: '🗡️' },
      { title: 'Platform Hero', meta: 'PS2 • Sample', icon: '👾' },
      { title: 'Soccer Pro', meta: 'PS4 • Placeholder', icon: '⚽' }
    ];

    container.innerHTML = samples.map(g => `
      <div class="game-card" data-demo="${g.title}">
        <div class="game-card-cover">${g.icon}</div>
        <div class="game-card-info">
          <div class="game-card-title">${g.title}</div>
          <div class="game-card-meta">${g.meta}</div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.game-card').forEach(card => {
      card.addEventListener('click', () => {
        this.toast('Ceci est un jeu de démonstration (pas de ROM réelle)', '');
        // On peut démarrer une simulation visuelle plus tard
      });
    });
  }

  startStatsLoop() {
    setInterval(() => {
      const stats = window.EmulatorCore.getStats();
      const fps = document.getElementById('stat-fps');
      const cpu = document.getElementById('stat-cpu');
      const ram = document.getElementById('stat-ram');
      const vram = document.getElementById('stat-vram');

      if (fps) fps.textContent = stats.fps;
      if (cpu) cpu.textContent = stats.cpu + '%';
      if (ram) ram.textContent = stats.ram + ' MB';
      if (vram) vram.textContent = stats.vram + ' MB';
    }, 1000);
  }
}

window.appUI = new AppUI();
