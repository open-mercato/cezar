/// Where a cold launch goes: the "In the shell" table of the spec, and nothing else.
enum StartDecision {
    enum Route {
        case manager, rootManagersOff, rootOldServer, rootLogin
        case askCredentials, passwordRejected, localMode, connectionError
    }

    static func decide(_ health: HealthAnswer, passwordSaved: Bool) -> Route {
        switch health.kind {
        case .cezar:
            guard let managers = health.managers else { return .rootOldServer }
            return managers ? .manager : .rootManagersOff
        case .basicGate:
            return passwordSaved ? .passwordRejected : .askCredentials
        case .localMode:
            return .localMode
        case .loginPage:
            return .rootLogin
        default:
            return .connectionError
        }
    }

    static func path(_ route: Route) -> String {
        route == .manager ? "/manager" : "/"
    }
}
