// Linux system utilities backend — stub.
//
// flushRam on Linux is `echo 3 > /proc/sys/vm/drop_caches`, which only
// works as root and only drops page/dentry/inode caches (no per-process
// working-set trimming — that doesn't exist on Linux the same way it
// does on Windows). Phase 2 can wire this up if we decide it's useful;
// for now the dashboard just sees a clean "not supported" response.

async function flushRam() {
  return { ok: false, error: 'flush-ram not yet implemented on linux' };
}

// Linux clipboard equivalent would be `xclip` / `wl-copy` for files,
// using `text/uri-list` MIME. Phase 2 wires this up against the kiosk
// image's clipboard daemon. Stub for now.
async function copyFilesToClipboard(paths) {
  return { ok: false, error: 'copy-files-clipboard not yet implemented on linux', count: 0 };
}

// BITS is a Windows-only service. Linux's equivalent (apt, snap, flatpak
// background downloads) all have their own progress APIs that don't map
// cleanly; the dashboard's filesystem download poll already covers most
// of what users actually care about. Returns empty so the caller's loop
// just iterates zero times instead of erroring.
async function getActiveBitsTransfers() {
  return [];
}

module.exports = { flushRam, copyFilesToClipboard, getActiveBitsTransfers };
