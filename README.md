# CandleTasks

A cozy Windows todo app with a daily streak candle and warm amber UI.

---

## Run in dev mode

```
npm install
npm start
```

---

## Build a Windows .exe

### Step 1: Generate the app icon (do this once)
```
node make-icon.js
```
This creates `icon.ico`. You can replace it with your own 256x256 `.ico` file anytime.

### Step 2: Install dependencies
```
npm install
```

### Step 3: Build
```
npm run build
```

This produces two files inside the `dist/` folder:

| File | What it is |
|---|---|
| `CandleTasks Setup 1.0.0.exe` | Installer — installs the app to Program Files, adds a desktop shortcut |
| `CandleTasks-portable.exe` | Portable — runs directly, no install needed, great for USB drives |

---

## Where your data is stored

Tasks file: `%APPDATA%\candletasks\tasks.md`  
Settings:   `%APPDATA%\candletasks\settings.json`  
Streak:     `%APPDATA%\candletasks\streak.json`

You can open `tasks.md` in any text editor. The path is also shown inside the app under Settings.

---

## Replace the icon

1. Create or find a 256x256 `.ico` file
2. Name it `icon.ico` and drop it in the project folder (replacing the generated one)
3. Run `npm run build` again

Free ico converters: convertio.co, icoconvert.com

---

## Build only the portable exe (faster)

```
npm run build:portable
```
