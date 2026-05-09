// audify ships prebuilds for napi v5..v10. If `npm install` was run with
// Node >= 21 the v10 prebuild gets installed, which crashes inside Electron
// 30 (Node 20 / N-API 9). This script forces the napi-v9 prebuild, which
// matches Electron 30's runtime.
//
// Idempotent: safe to run on every install. Skipped on non-win32 hosts.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const os = require('os');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log('[fix-audify-abi] skip — not win32-x64');
  process.exit(0);
}

const TARGET_NAPI = 9;
const VERSION = '1.10.1';
const URL = `https://github.com/almoghamdani/audify/releases/download/v${VERSION}/audify-v${VERSION}-napi-v${TARGET_NAPI}-win32-x64.tar.gz`;

const audifyDir = path.join(__dirname, '..', 'node_modules', 'audify');
const releaseDir = path.join(audifyDir, 'build', 'Release');
const stamp = path.join(releaseDir, '.napi-v9-installed');

if (!fs.existsSync(audifyDir)) {
  console.log('[fix-audify-abi] audify not installed — skipping');
  process.exit(0);
}

if (fs.existsSync(stamp)) {
  console.log('[fix-audify-abi] napi-v9 already installed');
  process.exit(0);
}

fs.mkdirSync(releaseDir, { recursive: true });
const tarPath = path.join(os.tmpdir(), `audify-v${VERSION}-napi-v${TARGET_NAPI}.tar.gz`);

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  try {
    console.log(`[fix-audify-abi] downloading napi-v${TARGET_NAPI} prebuild...`);
    await download(URL, tarPath);
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', audifyDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar exited ${r.status}`);
    fs.writeFileSync(stamp, new Date().toISOString());
    console.log('[fix-audify-abi] installed napi-v9 audify binary');
  } catch (err) {
    console.warn('[fix-audify-abi] failed:', err.message);
    console.warn('[fix-audify-abi] system audio loopback will not work until this is fixed.');
  } finally {
    try { fs.unlinkSync(tarPath); } catch {}
  }
})();
