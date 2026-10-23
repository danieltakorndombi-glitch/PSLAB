/* ===== file-loader.js ===== */
/**
 * File Loader – drag & drop + sélecteur de fichiers
 *
 * Les jeux (ISO / BIN / CHD…) sont copiés EN FLUX dans le stockage persistant
 * du navigateur (OPFS, sinon IndexedDB) : jamais chargés en entier dans la RAM,
 * et toujours disponibles au prochain lancement, même hors-ligne.
 * Le moteur d'émulation n'est démarré qu'au clic sur « Jouer ».
 *
 * Supprimer un jeu : appui long (ou clic droit) sur sa ligne.
 */

class FileLoader {
  constructor() {
    this.loadedFiles = [];      // métadonnées {id, name, size, ext, …} issues de PS.storage
    this._busy = false;
  }

  init() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnLoad = document.getElementById('btn-load-rom');

    if (!dropZone || !fileInput) return;

    // Jeux déjà présents dans le stockage persistant
    this.loadedFiles = window.PS.storage.list();
    this.renderLibrary();
    this.bindDelete();

    // Clic sur la zone → ouvre le sélecteur
    dropZone.addEventListener('click', () => fileInput.click());

    // Bouton rapide depuis l’accueil
    if (btnLoad) {
      btnLoad.addEventListener('click', () => {
        // On bascule sur la vue bibliothèque et on ouvre le sélecteur
        window.appUI.showView('library');
        setTimeout(() => fileInput.click(), 200);
      });
    }

    // Input change
    fileInput.addEventListener('change', (e) => {
      this.handleFiles(e.target.files);
      fileInput.value = ''; // reset pour pouvoir recharger le même fichier
    });

    // Drag & drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      dropZone.classList.remove('dragover');
      this.handleFiles(e.dataTransfer.files);
    });
  }

  async handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList);
    const validExt = ['.iso', '.bin', '.chd', '.pkg', '.cso', '.img', '.pbp'];

    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!validExt.includes(ext)) {
        window.appUI.toast(`Format non supporté : ${file.name}`, 'error');
        continue;
      }

      try {
        window.appUI.toast(`Copie de ${file.name}…`);
        let last = -1;
        const meta = await window.PS.storage.import(file, (p) => {
          const pct = Math.floor(p * 10) * 10;                    // un toast tous les 10 %
          if (pct !== last && pct > 0 && pct < 100) { last = pct; window.appUI.toast(`Copie de ${file.name}… ${pct}%`); }
        });
        this.addToLibrary(meta);
        window.appUI.toast(`${file.name} prêt`, 'success');
      } catch (err) {
        console.error(err);
        window.appUI.toast(err && err.message ? err.message : `Erreur lors du chargement de ${file.name}`, 'error');
      }
    }
  }

  addToLibrary(meta) {
    this.loadedFiles = this.loadedFiles.filter(m => m.id !== meta.id);
    this.loadedFiles.push(meta);
    this.renderLibrary();
  }

  renderLibrary() {
    const container = document.getElementById('loaded-games');
    if (!container) return;

    if (this.loadedFiles.length === 0) {
      container.innerHTML = '<p class="empty-msg">Aucun jeu chargé pour le moment.</p>';
      return;
    }

    container.innerHTML = this.loadedFiles.map((file, idx) => {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      return `
        <div class="game-item">
          <div class="game-item-icon">💿</div>
          <div class="game-item-info">
            <div class="game-item-name">${this.escape(file.name)}</div>
            <div class="game-item-size">${sizeMB} MB</div>
          </div>
          <div class="game-item-actions">
            <button data-idx="${idx}" class="btn-play">Jouer</button>
          </div>
        </div>
      `;
    }).join('');

    // Bind play buttons
    container.querySelectorAll('.btn-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        this.playFile(this.loadedFiles[idx]);
      });
    });
  }

  /** Appui long / clic droit sur un jeu → suppression du stockage (aucun élément visuel ajouté). */
  bindDelete() {
    const container = document.getElementById('loaded-games');
    if (!container || container._delBound) return;
    container._delBound = true;

    const targetOf = (e) => {
      const item = e.target.closest('.game-item');
      const btn = item && item.querySelector('.btn-play');
      return btn ? this.loadedFiles[parseInt(btn.dataset.idx, 10)] : null;
    };

    container.addEventListener('contextmenu', (e) => {
      const meta = targetOf(e);
      if (!meta) return;
      e.preventDefault();
      this.confirmRemove(meta);
    });

    let timer = null, fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    container.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || e.target.closest('.btn-play')) return;
      const meta = targetOf(e);
      if (!meta) return;
      fired = false;
      timer = setTimeout(() => { fired = true; this.confirmRemove(meta); }, 700);
    });
    ['pointerup', 'pointercancel', 'pointermove', 'pointerleave'].forEach(t => container.addEventListener(t, cancel));
  }

  async confirmRemove(meta) {
    if (!window.confirm(`Supprimer « ${meta.name} » du stockage de l’appareil ?`)) return;
    try {
      await window.PS.storage.remove(meta.id);
      this.loadedFiles = this.loadedFiles.filter(m => m.id !== meta.id);
      this.renderLibrary();
      window.appUI.toast(`${meta.name} supprimé`, 'success');
    } catch (err) {
      window.appUI.toast('Suppression impossible', 'error');
    }
  }

  async playFile(meta) {
    if (this._busy) return;
    this._busy = true;
    try {
      window.appUI.toast(`Démarrage de ${meta.name}…`);
      await window.EmulatorCore.loadRom(meta);

      // La vue jeu doit être visible AVANT le démarrage (le moteur dessine sur le canvas)
      window.appUI.showView('game');
      await window.EmulatorCore.start();

      document.getElementById('game-overlay').classList.add('hidden');
      document.getElementById('game-status').textContent = meta.name;

      // Afficher la manette automatiquement
      window.virtualGamepad.show();

      const engine = window.EmulatorCore.activeDesc;
      window.appUI.toast(`${meta.name} en cours${engine ? ' · ' + engine.name : ''}`, 'success');
    } catch (err) {
      console.error(err);
      try { await window.EmulatorCore.stop(); } catch (e) {}
      window.appUI.showView('library');
      window.appUI.toast(err.message || 'Impossible de démarrer le jeu', 'error');
    } finally {
      this._busy = false;
    }
  }

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.fileLoader = new FileLoader();
