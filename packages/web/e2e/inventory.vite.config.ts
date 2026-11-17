import original from '../vite.config'

// This fixture must never proxy requests or sockets to a user's running cockpit.
// HTTP APIs are intercepted by each browser test; unmatched local requests stay here.
export default { ...original, server: { proxy: {} } }
