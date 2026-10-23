# Compiler un cœur pour la passerelle `ps1-wasm`

Le plugin attend `plugins/cores/ps1-wasm/core/ps1.js` + `ps1.wasm`, exposant cette ABI C (voir l'en-tête de `plugins/cores/ps1-wasm/index.js`) :
`ps_init, ps_caps, ps_load, ps_run_frame, ps_set_button, ps_set_axis, ps_set_option, ps_reset, ps_shutdown, ps_video_ptr/width/height/format/pitch, ps_fps, ps_stat`.

Flags Emscripten typiques :
```
emcc ... -O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=cwrap,FS,PThread \
     -sEXPORTED_FUNCTIONS=_ps_init,_ps_caps,_ps_load,_ps_run_frame,_ps_set_button,_ps_set_axis,_ps_set_option,_ps_reset,_ps_shutdown,_ps_video_ptr,_ps_video_width,_ps_video_height,_ps_video_format,_ps_video_pitch,_ps_fps,_ps_stat \
     -o ps1.js
```
Lecture sans copie des gros jeux : ajoutez `-sWASMFS -pthread -lopfs.js`, montez OPFS dans `ps_init` avec `wasmfs_create_directory("/opfs", 0777, wasmfs_create_opfs_backend())` et renvoyez le bit 0 dans `ps_caps()`.
Le jeu est alors lu en place à `/opfs/ps-roms/<id>.rom`. Sinon : copie par blocs en MEMFS (limite `maxMemfsMB`).

Cœurs candidats (licences à vérifier, principalement GPL) : SwanStation / DuckStation, PCSX-ReARMed, Beetle PSX via libretro avec une fine couche C qui mappe `retro_run`, `retro_set_video_refresh` (copie vers le buffer `ps_video_ptr`), `retro_set_input_state` (tableaux alimentés par `ps_set_button/axis`) et `retro_load_game` (`ps_load`). Cette couche n'est pas fournie ni testée ici.
