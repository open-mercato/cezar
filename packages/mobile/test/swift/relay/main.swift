// The relay client on macOS against test-vectors/relay, fakes and real loopback sockets. It proves the
// logic, not that it builds for iOS (see README.md).
import Foundation

signal(SIGPIPE, SIG_IGN)
vectorsTests()
tunnelSessionTests()
pairingClientTests()
relayLinkTests()
relayConnectionsTests()
loopbackProxyTests()
bundleCacheTests()
relayServerTests()
transportTests()

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
