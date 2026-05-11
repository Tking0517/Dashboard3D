// System-level utilities adapter. Currently hosts:
//   flushRam() → ask the OS to release working-set pages held by every
//                process. Useful when memory pressure climbs and the
//                user wants the dashboard to nudge things free.
//
// Future: copyFilesToClipboard, listBitsTransfers, etc. — all the
// small Windows-only utilities that don't deserve their own service.

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
