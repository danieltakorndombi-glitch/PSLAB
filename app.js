/* ===== app.js ===== */
/**
 * Point d’entrée principal de l’application
 */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  try {
    // Mode « fichier unique » : sw.js peut être absent → on ne tente rien (pas d'erreur console)
    // (une erreur réseau n'est PAS une absence : hors-ligne on laisse le SW déjà installé travailler)
    const probe = await fetch('./sw.js', { method: 'HEAD', cache: 'no-store' }).catch(() => null);
    if (probe && !probe.ok) { console.info('[PWA] sw.js absent : mode en ligne uniquement'); return; }

    // Manifeste PWA (installation écran d'accueil) – ajouté s'il n'est pas déjà dans <head>
    if (!document.querySelector('link[rel="manifest"]')) {
      const m = await fetch('./manifest.webmanifest', { method: 'HEAD' }).catch(() => null);
      if (m && m.ok) {
        const l = document.createElement('link');
        l.rel = 'manifest'; l.href = './manifest.webmanifest';
        document.head.appendChild(l);
      }
    }

    const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    console.log('[PWA] Service Worker enregistré');

    // Le SW prévient quand une nouvelle version de l'application est prête
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'UPDATE_READY' && window.appUI) {
        window.appUI.toast('Mise à jour installée — elle sera active au prochain lancement', 'success');
      }
    });

    // Recherche de mises à jour : au retour sur l'onglet puis toutes les 30 min
    const check = () => {
      reg.update().catch(() => {});
      if (reg.active) reg.active.postMessage({ type: 'CHECK_UPDATE' });
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  } catch (e) {
    console.warn('[PWA] SW non enregistré', e);
  }
}

async function boot() {
  const bootScreen = document.getElementById('boot-screen');
  const bootBar = document.getElementById('boot-bar');
  const bootStatus = document.getElementById('boot-status');
  const app = document.getElementById('app');

  const steps = [
    { pct: 20, text: 'Chargement de l’interface…' },
    { pct: 45, text: 'Initialisation de la manette…' },
    { pct: 70, text: 'Préparation du chargeur de ROM…' },
    { pct: 90, text: 'Connexion au moteur d’émulation…' },
    { pct: 100, text: 'Prêt' }
  ];

  // Le vrai travail (stockage, catalogue de plugins, capacités GPU) tourne PENDANT l'animation
  const coreReady = window.EmulatorCore.init().catch(e => { console.error('[Core] init', e); return false; });

  for (const step of steps) {
    bootBar.style.width = step.pct + '%';
    bootStatus.textContent = step.text;
    await new Promise(r => setTimeout(r, 280));
  }
  await coreReady;

  // Init modules
  window.virtualGamepad.init();
  window.fileLoader.init();
  window.appUI.init();

  // Service Worker (PWA) – en arrière-plan, ne retarde pas l'affichage
  registerServiceWorker();

  // Transition
  bootScreen.style.opacity = '0';
  setTimeout(() => {
    bootScreen.classList.add('hidden');
    app.classList.remove('hidden');
  }, 500);
}

// Démarrage
document.addEventListener('DOMContentLoaded', boot);
