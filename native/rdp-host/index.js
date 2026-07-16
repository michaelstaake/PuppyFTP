'use strict'

let binding = null
let loadError = null

try {
  // Prefer Electron-rebuilt binary; fall back to node-gyp default layout.
  binding = require('./build/Release/rdp_host.node')
} catch (e1) {
  try {
    binding = require('bindings')('rdp_host')
  } catch (e2) {
    loadError = e1
    binding = null
  }
}

function unavailable(method) {
  return () => {
    throw new Error(
      loadError
        ? `RDP host native module unavailable: ${loadError.message}`
        : `RDP host native module unavailable (${method})`
    )
  }
}

if (!binding || binding.available === false) {
  module.exports = {
    available: false,
    create: unavailable('create'),
    connect: unavailable('connect'),
    setBounds: unavailable('setBounds'),
    setVisible: unavailable('setVisible'),
    disconnect: unavailable('disconnect'),
    destroy: unavailable('destroy'),
    destroyAll: unavailable('destroyAll'),
    isAvailable: () => false,
  }
} else {
  module.exports = binding
}
