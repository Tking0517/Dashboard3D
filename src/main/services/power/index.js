// Power profile adapter — chooses the right backend at load time.
// The dashboard's `setPowerProfile` IPC handler talks to this module
// without caring which OS it's on; only the concrete impl differs.
//
// Interface (all backends must export the same shape):
//   setProfile({ maxCpu, minCpu }) → Promise<{ ok, max?, min?, error? }>
//
// Both inputs are 0-100 percent. Backends clamp + validate themselves
// so the IPC handler stays a thin pass-through.

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
