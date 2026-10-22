/**
 * Point d’entrée principal de l’application
 */

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

  for (const step of steps) {
    bootBar.style.width = step.pct + '%';
    bootStatus.textContent = step.text;
    await new Promise(r => setTimeout(r, 280));
  }

  // Init core (simulation)
  await window.EmulatorCore.init();

  // Init modules
  window.virtualGamepad.init();
  window.fileLoader.init();
  window.appUI.init();

  // Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('[PWA] Service Worker enregistré');
    } catch (e) {
      console.warn('[PWA] SW non enregistré', e);
    }
  }

  // Transition
  bootScreen.style.opacity = '0';
  setTimeout(() => {
    bootScreen.classList.add('hidden');
    app.classList.remove('hidden');
  }, 500);
}

// Démarrage
document.addEventListener('DOMContentLoaded', boot);
