/* ===== storage.js ===== */
/**
 * ============================================================
 *  STOCKAGE PERSISTANT DES JEUX (ISO / BIN / CHD …)
 * ============================================================
 *
 *  Objectif : ne JAMAIS charger un jeu entier dans la RAM de JavaScript.
 *
 *  Backends (choisis automatiquement, du meilleur au plus basique) :
 *   1. OPFS  – Origin Private File System. Le fichier est copié en flux
 *              (blocs de 4 Mo) sur le disque ; la lecture se fait ensuite par
 *              File.slice() ou, dans un Worker, par un SyncAccessHandle.
 *              Sur Safari/iOS (pas de createWritable) la copie passe par un
 *              Worker + createSyncAccessHandle.
 *   2. IndexedDB – blocs de 4 Mo (navigateurs sans OPFS).
 *   3. Mémoire   – dernier recours (navigation privée stricte) : on garde
 *              l'objet File, qui reste de toute façon adossé au disque.
 *
 *  API publique (window.PS.storage) :
 *    await init()                    → détecte le backend, relit l'index
 *    list()                          → [{id,name,size,ext,added,…}]
 *    await import(file, onProgress)  → meta (copie en flux, sans RAM)
 *    await open(id | meta)           → RomHandle
 *    await remove(id)
 *    await estimate()                → { usage, quota }
 *
 *  RomHandle :
 *    { id, name, size, ext,
 *      readRange(offset, length) → Promise<Uint8Array>   (lecture ciblée)
 *      asFile()                  → Promise<Blob>         (Blob adossé au disque en OPFS)
 *      opfs                      → { dir, name } | null  (pour un Worker avec SyncAccessHandle)
 *    }
 */
(function () {
  'use strict';

  const PS = (window.PS = window.PS || {});
  const INDEX_KEY = 'ps-rom-index-v1';
  const OPFS_DIR = 'ps-roms';
  const CHUNK = 4 * 1024 * 1024;

  const extOf = name => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };

  /* ------------------------------------------------------------------ */
  /*  Worker de copie (Safari / iOS : pas de createWritable)            */
  /* ------------------------------------------------------------------ */
  const COPY_WORKER_SRC = `
    self.onmessage = async (e) => {
      const { dir, name, file } = e.data;
      let sah;
      try {
        const root = await navigator.storage.getDirectory();
        const d = await root.getDirectoryHandle(dir, { create: true });
        const fh = await d.getFileHandle(name, { create: true });
        sah = await fh.createSyncAccessHandle();
        sah.truncate(0);
        const CH = ${CHUNK};
        for (let o = 0; o < file.size; o += CH) {
          const buf = new Uint8Array(await file.slice(o, Math.min(o + CH, file.size)).arrayBuffer());
          sah.write(buf, { at: o });
          self.postMessage({ progress: Math.min(o + CH, file.size) / file.size });
        }
        sah.flush(); sah.close();
        self.postMessage({ done: true });
      } catch (err) {
        try { sah && sah.close(); } catch (_) {}
        self.postMessage({ error: String((err && err.message) || err) });
      }
    };`;

  /* ------------------------------------------------------------------ */
  /*  Backend OPFS                                                      */
  /* ------------------------------------------------------------------ */
  class OpfsBackend {
    static supported() {
      return !!(navigator.storage && navigator.storage.getDirectory && window.isSecureContext !== false);
    }
    get name() { return 'opfs'; }

    async init() {
      const root = await navigator.storage.getDirectory();
      this.dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      this.canWritable = typeof FileSystemFileHandle !== 'undefined' &&
        typeof FileSystemFileHandle.prototype.createWritable === 'function';
    }

    fileName(id) { return id + '.rom'; }

    async put(id, file, onProgress) {
      const fname = this.fileName(id);
      if (this.canWritable) {
        try { return await this._putStream(fname, file, onProgress); }
        catch (e) {
          // Certains navigateurs exposent createWritable mais échouent → repli Worker
          console.warn('[Storage] createWritable indisponible, repli Worker', e);
          this.canWritable = false;
        }
      }
      return this._putWorker(fname, file, onProgress);
    }

    async _putStream(fname, file, onProgress) {
      const fh = await this.dir.getFileHandle(fname, { create: true });
      const writable = await fh.createWritable();
      let loaded = 0;
      const counter = new TransformStream({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          onProgress && onProgress(Math.min(1, loaded / (file.size || 1)));
          ctl.enqueue(chunk);
        }
      });
      try {
        await file.stream().pipeThrough(counter).pipeTo(writable);
      } catch (e) {
        try { await this.dir.removeEntry(fname); } catch (_) {}
        throw e;
      }
    }

    _putWorker(fname, file, onProgress) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([COPY_WORKER_SRC], { type: 'text/javascript' }));
        const w = new Worker(url);
        const finish = (fn, arg) => { w.terminate(); URL.revokeObjectURL(url); fn(arg); };
        w.onmessage = e => {
          const d = e.data || {};
          if (d.progress != null) onProgress && onProgress(d.progress);
          else if (d.done) finish(resolve);
          else if (d.error) { this.dir.removeEntry(fname).catch(() => {}); finish(reject, new Error(d.error)); }
        };
        w.onerror = e => finish(reject, new Error(e.message || 'Worker error'));
        w.postMessage({ dir: OPFS_DIR, name: fname, file });
      });
    }

    async exists(id) {
      try { await this.dir.getFileHandle(this.fileName(id)); return true; } catch (e) { return false; }
    }

    async open(meta) {
      const fh = await this.dir.getFileHandle(this.fileName(meta.id));
      const file = await fh.getFile();     // File adossé au disque : lecture paresseuse
      return makeHandle(meta, {
        readRange: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()),
        asFile: async () => file,
        opfs: { dir: OPFS_DIR, name: this.fileName(meta.id) }
      });
    }

    async remove(id) {
      try { await this.dir.removeEntry(this.fileName(id)); } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Backend IndexedDB (blocs de 4 Mo)                                 */
  /* ------------------------------------------------------------------ */
  class IdbBackend {
    static supported() { return typeof indexedDB !== 'undefined'; }
    get name() { return 'indexeddb'; }

    init() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('ps-emu-roms', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'i'] });
        };
        req.onsuccess = () => { this.db = req.result; resolve(); };
        req.onerror = () => reject(req.error);
      });
    }

    _tx(mode) { return this.db.transaction('chunks', mode).objectStore('chunks'); }
    _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

    async put(id, file, onProgress) {
      await this.remove(id);
      try {
        for (let o = 0, i = 0; o < file.size; o += CHUNK, i++) {
          const data = await file.slice(o, Math.min(o + CHUNK, file.size)).arrayBuffer();
          await this._req(this._tx('readwrite').put({ id, i, data }));
          onProgress && onProgress(Math.min(1, (o + CHUNK) / (file.size || 1)));
        }
      } catch (e) { await this.remove(id); throw e; }
    }

    async exists(id) {
      const k = await this._req(this._tx('readonly').getKey(IDBKeyRange.bound([id, 0], [id, Infinity])));
      return k !== undefined;
    }

    async open(meta) {
      const id = meta.id, self = this;
      return makeHandle(meta, {
        async readRange(off, len) {
          const end = Math.min(off + len, meta.size);
          const out = new Uint8Array(Math.max(0, end - off));
          for (let i = Math.floor(off / CHUNK); i * CHUNK < end; i++) {
            const rec = await self._req(self._tx('readonly').get([id, i]));
            if (!rec) break;
            const buf = new Uint8Array(rec.data), base = i * CHUNK;
            const s = Math.max(off, base), e = Math.min(end, base + buf.length);
            out.set(buf.subarray(s - base, e - base), s - off);
          }
          return out;
        },
        async asFile() {
          // ⚠ reconstruit un Blob en mémoire : à éviter pour de très gros jeux
          const parts = [];
          const all = await self._req(self._tx('readonly').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
          all.sort((a, b) => a.i - b.i).forEach(r => parts.push(r.data));
          return new Blob(parts);
        },
        opfs: null
      });
    }

    async remove(id) {
      try { await this._req(this._tx('readwrite').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))); } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Backend mémoire (dernier recours)                                 */
  /* ------------------------------------------------------------------ */
  class MemoryBackend {
    get name() { return 'memory'; }
    async init() { this.files = new Map(); }
    async put(id, file, onProgress) { this.files.set(id, file); onProgress && onProgress(1); }
    async exists(id) { return this.files.has(id); }
    async open(meta) {
      const file = this.files.get(meta.id);
      if (!file) throw new Error('Fichier introuvable');
      return makeHandle(meta, {
        readRange: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()),
        asFile: async () => file,
        opfs: null
      });
    }
    async remove(id) { this.files.delete(id); }
  }

  function makeHandle(meta, impl) {
    return Object.assign({ id: meta.id, name: meta.name, size: meta.size, ext: meta.ext, release() {} }, impl);
  }

  /* ------------------------------------------------------------------ */
  /*  RomStorage                                                        */
  /* ------------------------------------------------------------------ */
  class RomStorage {
    constructor() { this.backend = null; this.index = []; this.ready = null; }

    init() {
      if (!this.ready) this.ready = this._init();
      return this.ready;
    }

    async _init() {
      const candidates = [OpfsBackend, IdbBackend, MemoryBackend];
      for (const B of candidates) {
        if (B.supported && !B.supported()) continue;
        try {
          const b = new B();
          await b.init();
          this.backend = b;
          break;
        } catch (e) { console.warn('[Storage] backend', B.name, 'indisponible →', e && e.message); }
      }
      if (!this.backend) { this.backend = new MemoryBackend(); await this.backend.init(); }
      console.log('[Storage] backend :', this.backend.name);

      this._loadIndex();
      await this.reconcile();
      return this.backend.name;
    }

    get persistent() { return this.backend && this.backend.name !== 'memory'; }
    get backendName() { return this.backend ? this.backend.name : 'none'; }

    _loadIndex() {
      if (!this.persistent) { this.index = []; return; }
      try { this.index = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch (e) { this.index = []; }
      if (!Array.isArray(this.index)) this.index = [];
    }
    _saveIndex() {
      if (!this.persistent) return;
      try { localStorage.setItem(INDEX_KEY, JSON.stringify(this.index)); } catch (e) {}
    }

    /** Retire de l'index les jeux dont les données ont disparu (cache vidé…). */
    async reconcile() {
      const kept = [];
      for (const m of this.index) { if (await this.backend.exists(m.id)) kept.push(m); }
      if (kept.length !== this.index.length) { this.index = kept; this._saveIndex(); }
    }

    list() { return this.index.slice(); }
    get(id) { return this.index.find(m => m.id === id) || null; }

    static async idFor(file) {
      const raw = `${file.name}|${file.size}|${file.lastModified || 0}`;
      try {
        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
        return [...new Uint8Array(buf)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
        return 'h' + (h >>> 0).toString(16);
      }
    }

    async estimate() {
      try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; }
      catch (e) { return { usage: 0, quota: 0 }; }
    }

    async import(file, onProgress) {
      await this.init();
      const id = await RomStorage.idFor(file);
      const existing = this.get(id);
      if (existing && await this.backend.exists(id)) { onProgress && onProgress(1); return existing; }

      if (this.persistent) {
        const { usage, quota } = await this.estimate();
        if (quota && file.size > quota - usage) {
          throw new Error('Espace de stockage insuffisant sur cet appareil');
        }
        // Demande de stockage "persistant" (évite l'éviction automatique par le navigateur)
        try { navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      }

      await this.backend.put(id, file, onProgress);
      const meta = { id, name: file.name, size: file.size, ext: extOf(file.name),
                     added: Date.now(), lastModified: file.lastModified || 0, backend: this.backend.name };
      this.index = this.index.filter(m => m.id !== id);
      this.index.push(meta);
      this._saveIndex();
      return meta;
    }

    async open(ref) {
      await this.init();
      const meta = typeof ref === 'string' ? this.get(ref) : ref;
      if (!meta) throw new Error('Jeu introuvable dans le stockage');
      return this.backend.open(meta);
    }

    async remove(id) {
      await this.init();
      await this.backend.remove(id);
      this.index = this.index.filter(m => m.id !== id);
      this._saveIndex();
    }

    /** Handle éphémère pour un File non importé (appel direct EmulatorCore.loadRom(file)). */
    static handleFromFile(file) {
      const meta = { id: 'tmp-' + Date.now(), name: file.name || 'buffer', size: file.size, ext: extOf(file.name || '') };
      return makeHandle(meta, {
        readRange: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()),
        asFile: async () => file,
        opfs: null
      });
    }
  }

  PS.RomStorage = RomStorage;
  PS.storage = new RomStorage();
  PS.extOf = extOf;
})();
