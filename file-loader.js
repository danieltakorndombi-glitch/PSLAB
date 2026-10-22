/**
 * File Loader – prêt pour un vrai moteur
 * Gère drag & drop + input file
 * Appelle EmulatorCore.loadRom() quand un fichier est sélectionné
 */

class FileLoader {
  constructor() {
    this.loadedFiles = [];
  }

  init() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnLoad = document.getElementById('btn-load-rom');

    if (!dropZone || !fileInput) return;

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
    const validExt = ['.iso', '.bin', '.chd', '.pkg', '.cso', '.img'];

    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!validExt.includes(ext)) {
        window.appUI.toast(`Format non supporté : ${file.name}`, 'error');
        continue;
      }

      // Ajouter à la liste visuelle immédiatement
      this.addToLibrary(file);

      // Charger dans le core (simulation pour l’instant)
      try {
        window.appUI.toast(`Chargement de ${file.name}…`);
        await window.EmulatorCore.loadRom(file);
        window.appUI.toast(`${file.name} prêt`, 'success');
      } catch (err) {
        console.error(err);
        window.appUI.toast(`Erreur lors du chargement de ${file.name}`, 'error');
      }
    }
  }

  addToLibrary(file) {
    this.loadedFiles.push(file);
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

  async playFile(file) {
    try {
      window.appUI.toast(`Démarrage de ${file.name}…`);
      await window.EmulatorCore.loadRom(file);
      await window.EmulatorCore.start();

      // Afficher la vue jeu
      window.appUI.showView('game');
      document.getElementById('game-overlay').classList.add('hidden');
      document.getElementById('game-status').textContent = file.name;

      // Afficher la manette automatiquement
      window.virtualGamepad.show();

      window.appUI.toast(`${file.name} en cours (simulation)`, 'success');
    } catch (err) {
      console.error(err);
      window.appUI.toast(err.message || 'Impossible de démarrer le jeu', 'error');
    }
  }

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.fileLoader = new FileLoader();
