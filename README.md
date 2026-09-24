# Re-region Saves (front-end only, decrypted saves)

Standalone static site — no server, no accounts. Everything runs in the browser.

## Run it

`titles.db` is loaded with `fetch()`, so you must serve the folder over HTTP
(`file://` will fail):

```bat
git clone https://github.com/m2k7m/re-region-web.git
cd re-region-web
python -m http.server 8000
```

then open http://localhost:8000/

## Use

1. Drop your **zipped decrypted** save onto the upload box (same look as the
   main site's Resign page), then **Analyze Save**.
2. The page reads `param.sfo`, shows the current `TitleID` + game + region flag from `titles.db`.
3. Type the target `TitleID` (suggestions with SVG flags appear from the
   same game via `concept_id`) or pick a suggestion. Must stay in the same
   `CUSA`/`PPSA` family; IDs missing from `titles.db` are allowed with a
   warning.
4. **Re-region & Download** patches every `param.sfo` in the zip and downloads
   `<original>_to_<NEWID>.zip`.

## What gets patched

Mirrors `[orbis.py](https://git.etawen.dev/earthonion/htos-web/src/commit/9fc6b46459d8e187ca2f7357407eabffc3fe7e0e/utils/orbis.py)`, applied as a byte-exact
in-place patch (original header/offsets/size preserved — only the patched
params' value bytes and used-lengths change):

- `TITLE_ID` → target (always).
- `SAVEDATA_DIRECTORY` → `<ID>01` for Xenoblade 2 IDs, MGSV `MGSV*SaveDataXX`
  names, Minecraft legacy prefix swap. Untouched for all other games.

⚠️ MGSV also needs a save-data crypt re-key (backend `reregion_change_crypt`
with an encrypted sample save) — the site warns about this; SFO-only output
may not load for those 6 IDs. Encrypted saves are out of scope.

## Files

- `index.html` — UI (upload box + button below, no sidebar).
- `style.css` — adapted from `[htos-web](https://git.etawen.dev/earthonion/htos-web/src/commit/9fc6b46459d8e187ca2f7357407eabffc3fe7e0e/static/style.css)`.
- `app.js` — zip/SFO/DB/patch logic (CDN: JSZip 3.10.1, sql.js 1.8.0).
- `titles.db` — copy of the repo-root DB (61k titles, regions US/EU/JP/AS/KR).

## Credits
- me
- [earthonion](https://git.etawen.dev/earthonion)