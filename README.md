# CandleTasks

A cozy Windows to-do app with a daily streak candle and a warm amber UI.

---

## Run in dev mode

```
npm install
npm start
```

## Run the tests

```
npm test
```

The tests cover the plain-word task parser (`nlp.js`) and the data validation in `main.js`
(dates, size limits, streak and settings sanitising). They need no Electron install to run.

---

## Build a Windows .exe

```
npm install
npm run build
```

This produces two files inside `dist/`:

| File | What it is |
|---|---|
| `CandleTasks Setup 1.0.0.exe` | Installer. Installs for the current user (no admin rights needed), adds a desktop shortcut |
| `CandleTasks-portable.exe` | Portable. Runs directly, no install needed, good for USB drives |

For a faster build of just the portable file: `npm run build:portable`.

Unsigned builds show a Windows SmartScreen warning on first run. Code signing is the only fix.

---

## Updates

- **Installed version:** when the app starts (and every 6 hours while it stays open) it checks GitHub
  Releases if you're online. If there's a newer version, a dialog offers **Download now** or **Later**.
  Only the changed parts of the installer are downloaded (differential update), then **Restart now**
  installs it. Choosing Later on a downloaded update installs it the next time you quit.
- **Portable version:** a portable `.exe` can't replace itself, so it only tells you a newer version
  exists and opens the releases page.
- **Check now / turn off:** Settings > App updates.
- Updates are not checked when running from source (`npm start`).

### One-time setup

1. In `package.json`, set `build.publish[0].owner` (and `repo`) to your GitHub account and repository.
2. Run `npm install` (this adds `electron-updater` and updates `package-lock.json`).

### Releasing an update

1. Bump `version` in `package.json` (for example `1.1.0` to `1.2.0`) and run `npm run build`.
2. On GitHub, create a **new release whose tag is `v` + the version** (`v1.2.0`). It must be published,
   not a draft or pre-release.
3. Upload these files from `dist/` to the release:
   - `CandleTasks-Setup-1.2.0.exe`
   - `CandleTasks-Setup-1.2.0.exe.blockmap`
   - `latest.yml`
   - `CandleTasks-portable.exe`
4. Never delete the `.blockmap` file of an old release. The next update uses it to work out which parts changed.

The first version that contains the updater (1.1.0) has to be installed by hand once; installs of older
versions can't update themselves.

---

## Where your data is stored

| File | Purpose |
|---|---|
| `%APPDATA%\candletasks\tasks.json` | Your tasks and lists. This is the file the app reads and writes |
| `%APPDATA%\candletasks\tasks.md` | A human-readable copy, rewritten on every save. Editing it does **not** change your tasks |
| `%APPDATA%\candletasks\streak.json` | Streak history |
| `%APPDATA%\candletasks\settings.json` | App settings |
| `Documents\CandleTasks Backups\` | Backups made from Settings, plus an automatic safety copy before every restore |

If you choose a sync folder in Settings (Dropbox, OneDrive, Syncthing...), `tasks.json`,
`tasks.md` and `streak.json` live there instead. If that folder is unavailable at start-up, the app
warns you and falls back to the local copy.

If a data file ever can't be parsed, the app keeps a `*.corrupt-<id>.json` copy next to it and
refuses to overwrite it from the quick-add popup.

---

## Privacy and security

- Everything stays on your computer unless you point the app at a sync folder. There is no
  telemetry or account. The only network request the app makes is the update check to this
  project's GitHub Releases page (turn it off in Settings > Check for updates automatically).
- The app windows run sandboxed, with no Node access, a strict Content-Security-Policy, and no
  navigation or pop-ups. Messages to the main process are accepted only from the app's own pages.
- Data read from disk (tasks, streak, backups, settings) is treated as untrusted and validated,
  because sync folders and backup files can be edited by other people or programs.

Found a problem? Please open an issue, or report security problems privately.

---

## Replace the icon

1. Create or find a 256x256 `.ico` file (it can contain smaller sizes too)
2. Name it `icon.ico` and drop it in the project folder, replacing the existing one
3. Run `npm run build` again

Free ico converters: convertio.co, icoconvert.com
