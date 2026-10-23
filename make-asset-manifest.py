#!/usr/bin/env python3
"""A lancer dans ce dossier après toute modification de index.html / registry.js / ... : regenere asset-manifest.json."""
import hashlib, json, pathlib
root = pathlib.Path(__file__).resolve().parent
shell = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'registry.js', 'storage.js', 'core-bridge.js', 'gamepad.js', 'file-loader.js', 'ui.js', 'app.js']
h = hashlib.sha1()
for f in shell[1:]: h.update(f.encode()); h.update((root/f).read_bytes())
m = json.loads((root/'asset-manifest.json').read_text()); m['version'] = h.hexdigest()[:12]
(root/'asset-manifest.json').write_text(json.dumps(m, indent=2)); print('version', m['version'])
