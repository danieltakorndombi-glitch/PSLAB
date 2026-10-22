/**
 * ============================================================
 *  CORE INTERFACE – Point d’entrée pour un vrai moteur d’émulation
 * ============================================================
 *
 *  Plus tard, quand tu auras un moteur WebAssembly (Play!, PCSX2 WASM,
 *  ou autre), tu remplaces simplement le contenu de cet objet.
 *
 *  L’interface reste la même → le reste de l’app continue de fonctionner
 *  sans modification majeure.
 */

window.EmulatorCore = {
  // État
  isReady: false,
  isRunning: false,
  currentRom: null,

  /**
   * Initialisation du moteur (appelé au démarrage de l’app)
   * Ici on simule juste un délai.
   * Plus tard : charger le .wasm, initialiser le contexte WebGL/WebGPU, etc.
   */
  async init() {
    console.log("[Core] Initialisation du moteur (simulation)…");
    await new Promise(r => setTimeout(r, 800));
    this.isReady = true;
    console.log("[Core] Moteur prêt (mode simulation)");
    return true;
  },

  /**
   * Charge un fichier ROM / ISO / BIN
   * @param {File|ArrayBuffer} file
   * @returns {Promise<boolean>}
   *
   * PLUS TARD : tu envoies le buffer au moteur WASM
   * Exemple :
   *   const buffer = await file.arrayBuffer();
   *   Module.ccall('load_rom', ... , [buffer]);
   */
  async loadRom(file) {
    console.log("[Core] Chargement de :", file.name || "buffer");
    this.currentRom = file;

    // Simulation de chargement
    await new Promise(r => setTimeout(r, 1200));

    // Ici tu pourras faire :
    // if (!this._realCore.load(buffer)) throw new Error("Format non supporté");

    return true;
  },

  /**
   * Démarre l’émulation
   */
  async start() {
    if (!this.currentRom) {
      throw new Error("Aucun ROM chargé");
    }
    console.log("[Core] Démarrage de l’émulation (simulation)");
    this.isRunning = true;

    // PLUS TARD : lancer la boucle de rendu du moteur
    // Module.ccall('start_emulation');
  },

  /**
   * Arrête l’émulation
   */
  stop() {
    console.log("[Core] Arrêt");
    this.isRunning = false;
    // Module.ccall('stop_emulation');
  },

  /**
   * Envoie l’état d’un bouton / stick au moteur
   * @param {string} button  - nom du bouton (cross, triangle, l1, left_x, …)
   * @param {number} value   - 0 ou 1 pour bouton, -1..1 pour stick
   */
  setInput(button, value) {
    // PLUS TARD : transmettre au moteur
    // Module.ccall('set_input', null, ['string', 'number'], [button, value]);
    // Pour l’instant on log juste en mode debug
    // console.log(`[Input] ${button} = ${value}`);
  },

  /**
   * Applique les paramètres (échelle, frame skip, etc.)
   */
  applySettings(settings) {
    console.log("[Core] Application des paramètres :", settings);
    // PLUS TARD : les envoyer au moteur
  },

  /**
   * Retourne les stats actuelles (pour le moniteur)
   * PLUS TARD : lire les vraies valeurs du moteur
   */
  getStats() {
    return {
      fps: this.isRunning ? 58 + Math.floor(Math.random() * 5) : 0,
      cpu: this.isRunning ? 30 + Math.floor(Math.random() * 40) : 5,
      ram: this.isRunning ? 120 + Math.floor(Math.random() * 50) : 40,
      vram: this.isRunning ? 80 + Math.floor(Math.random() * 30) : 20
    };
  }
};
