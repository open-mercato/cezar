// Runs the plain push classes on macOS, with no Xcode and no XCTest: the Java push tests, ported
// one function per test class. It proves their logic, not that they build for iOS.
import Foundation

cezarPushTest()
foregroundServersTest()
graceCloseTest()
grantClientTest()
pushCoordinatorTest()
pushTapTest()
renewalPolicyTest()
signalParserTest()
signalStreamTest()

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
