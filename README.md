# PS Web Emulator – Prototype iOS / GitHub Pages

Interface web moderne style PlayStation, optimisée pour iPhone (Safari), prête à être déployée sur **GitHub Pages**.

Ce n’est **pas encore un vrai émulateur** capable de lancer des jeux PS2/PS4.  
C’est une base solide et propre, conçue pour que tu puisses plus tard brancher un vrai moteur WebAssembly sans tout réécrire.

---

## Fonctionnalités actuelles

- Interface dark style PlayStation
- Manette virtuelle tactile complète (sticks analogiques + boutons + L1/R1/L2/R2 + vibration haptique)
- Chargeur de fichiers (drag & drop + sélection) pour ISO / BIN / CHD / PKG…
- Bibliothèque de jeux chargés
- Paramètres (échelle, frame skip, filtres, sensibilité, haptique)
- Moniteur de performances (simulé)
- PWA complète → tu peux l’ajouter à l’écran d’accueil de l’iPhone
- Architecture modulaire : le fichier `js/core-interface.js` est le point unique où brancher un vrai moteur

---

## Déploiement sur GitHub Pages (très simple)

1. Crée un nouveau dépôt public sur GitHub (ex : `ps-web-emulator`)
2. Upload tous les fichiers de ce dossier à la racine du dépôt
3. Va dans **Settings → Pages**
4. Source : **Deploy from a branch** → Branch `main` → folder `/ (root)`
5. Attends 1-2 minutes
6. Ton site sera disponible sur :  
   `https://TON-PSEUDO.github.io/ps-web-emulator/`

### Ajouter à l’écran d’accueil iPhone
1. Ouvre le lien dans Safari
2. Appuie sur le bouton Partager → **Sur l’écran d’accueil**
3. L’icône apparaît comme une vraie app

---

## Structure des fichiers

```
ps-web-emulator/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js              ← démarrage
│   ├── ui.js               ← navigation & toasts
│   ├── gamepad.js          ← manette tactile
│   ├── file-loader.js      ← chargement de ROM
│   └── core-interface.js   ← ★ ICI tu brancheras le vrai moteur
├── manifest.json
├── sw.js
├── icons/
└── README.md
```

---

## Comment brancher un vrai moteur plus tard

Ouvre `js/core-interface.js`.  
Tu verras clairement les méthodes :

- `init()`
- `loadRom(file)`
- `start()` / `stop()`
- `setInput(button, value)`
- `applySettings(settings)`
- `getStats()`

Remplace le contenu de ces méthodes par les appels à ton moteur WASM (Play!, un port de PCSX2, etc.).  
Le reste de l’application (UI + manette + chargeur) continuera de fonctionner sans changement.

---

## Notes importantes

- Sur iOS, les performances d’un vrai émulateur PS2 en WebAssembly restent très limitées aujourd’hui.
- Les fichiers ROM/BIOS restent de ta responsabilité (légalité).
- Ce projet est fourni à titre éducatif et de prototypage.

---

Bon développement !  
Quand tu auras un moteur qui marche, reviens ici et on l’intégrera proprement.
