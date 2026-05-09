# Dashboard3D

A desktop 3D dashboard built with **Electron**, **Vite**, and **Three.js**. Shows live system info, storage, date/time, and weather (via [Open-Meteo](https://open-meteo.com) — free, no API key).

## Quick start

```bash
npm install
npm run dev
```

## Build (Windows)

```bash
npm run package
```

## Widgets

| Widget | Source |
|---|---|
| Date / Time | Client clock, ticks every second |
| Weather | Open-Meteo current conditions + geocoding (city input) |
| System | Electron `os` module via IPC (CPU, memory, uptime, platform, hostname) |
| Storage | Node `fs.statfs` via IPC (free / total per drive) |

## Stack

- Electron 30 — desktop shell
- Vite 5 — dev server / build
- Three.js r164 — 3D scene
- Vanilla JS (ESM) renderer
- systeminformation — CPU / GPU temps + per-interface network rates

## Config

The app starts in **fullscreen**; press **F11** to toggle.

User state (weather city, alt-clock city) is stored as JSON at:

```
%APPDATA%\Dashboard3D\config.json
```

This file persists across launches and `npm run package` runs. Delete it to reset.
