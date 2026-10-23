# PS Web Emulator — architecture modulaire (PWA + WebAssembly)

UI, CSS et balises HTML **inchangés** par rapport à votre `index.html`. Seuls les scripts internes ont été restructurés.

## Déploiement GitHub Pages
Copiez le contenu du dossier `ps-web-emulator/` à la racine du dépôt (ou dans `/docs`), activez Pages. Aucune étape de build.
Alternative : `index.html` autonome (tout est embarqué, plugins chargés via `import()` sur Blob URL) — fonctionne sans serveur ; sans `sw.js` voisin, pas de mode hors-ligne.

## Structure
| Fichier | Rôle |
|---|---|
| `src/registry.js` | Registre de composants + chargement dynamique `import()` |
| `src/core-bridge.js` | `window.EmulatorCore` : même API qu'avant, mais passerelle réelle vers les plugins |
| `src/storage.js` | Stockage persistant des jeux : OPFS → IndexedDB → mémoire |
| `src/file-loader.js`, `ui.js`, `gamepad.js`, `app.js` | Logique de l'interface (balisage inchangé) |
| `plugins/registry.json` | Catalogue des moteurs/rendus (modifiable sans rebuild) |
| `plugins/renderers/` | WebGL2, WebGPU, Canvas2D |
| `plugins/cores/demo/` | Cœur de diagnostic (sans WASM) : valide toute la chaîne |
| `plugins/cores/ps1-wasm/` | Passerelle Emscripten (ABI dans `docs/BUILD-CORE.md`) |
| `sw.js`, `asset-manifest.json` | Service Worker : coque versionnée + plugins mis à jour à chaud |

## Ajouter un moteur (sans toucher à l'application)
1. Créez `plugins/cores/<nom>/index.js` exportant `{ id, create(ctx) }` (copiez `demo/index.js`).
2. Ajoutez son descripteur dans `plugins/registry.json` (id, kind:"core", url, extensions, priority, requires).
3. Poussez. Les utilisateurs le reçoivent à leur prochaine ouverture en ligne. Incrémentez `version` pour forcer le rafraîchissement immédiat.
Console : `EmulatorCore.getInfo()`, `EmulatorCore.setPreferredCore('id')`.

## Mises à jour (Service Worker)
- Coque : empreinte dans `asset-manifest.json` ; nouvelle version téléchargée en bloc, activée au lancement suivant (toast « Mise à jour installée »).
- Plugins : `registry.json` réseau-d'abord ; modules `.js` stale-while-revalidate ; `.wasm` cache-d'abord (URL versionnée `?v=`).
- ⚠ Après modification de fichiers de la coque (`index.html`, `src/*`), régénérez `asset-manifest.json` (`python3 tools/make-asset-manifest.py`) : son empreinte déclenche la mise à jour.
- Le SW ajoute COOP/COEP (SharedArrayBuffer → cœurs multi-threads) à partir du 2e chargement. Désactivable : `ENABLE_ISOLATION=false`.

## Limites connues
- **Aucun émulateur PS1/PS2 n'est fourni** : il faut compiler un cœur (voir `docs/BUILD-CORE.md`). Sans lui, le cœur « Diagnostic » prend le relais (analyse ISO/BIN/CHD, rendu, manette en direct).
- Audio non inclus (à gérer côté cœur).
- Les libellés « Performances (simulées) » de l'accueil sont conservés tels quels (UI inchangée) alors que les valeurs sont maintenant réelles (VRAM = estimation).
- Suppression d'un jeu : appui long / clic droit sur sa ligne (aucun bouton ajouté).
- BIOS : à fournir par vos soins dans `plugins/cores/ps1-wasm/bios/` (dossier public sur Pages).
