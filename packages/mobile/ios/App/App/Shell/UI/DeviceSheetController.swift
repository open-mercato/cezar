import UIKit

/// The native device switcher over a server page: one row per saved server, its status dot, a tick on the
/// current one, then Add a device and Manage devices. Server pages learn nothing of it: it opens from
/// `cezar://servers` and the banner's Devices button, both native.
final class DeviceSheetController: UITableViewController {
    enum Choice {
        /// Open this outcome in place of the page on screen.
        case open(ShellConnector.Outcome)
        /// Leave to the connect page, as the server view's own routes do.
        case leave(ShellRoute)
    }

    private let connector: ShellConnector
    private let currentId: String
    private let currentPath: String?
    private let onChoice: (Choice) -> Void
    private var servers: [ServerRecord] = []
    private var rows: [DeviceSwitch.Row] = []
    private var probes: DeviceProbes?
    private var switching: String?
    private var chosen = false

    private enum Section: Int, CaseIterable { case devices, actions }

    init(connector: ShellConnector, currentId: String, currentPath: String?, onChoice: @escaping (Choice) -> Void) {
        self.connector = connector
        self.currentId = currentId
        self.currentPath = currentPath
        self.onChoice = onChoice
        super.init(style: .insetGrouped)
        title = "Devices"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        probes?.stop()
    }

    /// In a navigation controller for the title: medium and large on a phone, a form-sheet card on an iPad.
    func wrapped() -> UINavigationController {
        let navigation = UINavigationController(rootViewController: self)
        navigation.overrideUserInterfaceStyle = .dark
        navigation.modalPresentationStyle = .formSheet
        navigation.preferredContentSize = CGSize(width: 480, height: 520)
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.prefersEdgeAttachedInCompactHeight = true
            sheet.widthFollowsPreferredContentSizeWhenEdgeAttached = true
        }
        return navigation
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        servers = connector.list()
        let relay = ShellServices.relay
        let probes = DeviceProbes(relay: DeviceProbes.relayProbe(relay),
                                  direct: DeviceProbes.directProbe(connector) { server in
                                      guard let url = server.url else { return nil }
                                      return await WebsiteData.cookieHeader(serverId: server.id, url: url)
                                  },
                                  release: { server in relay.releaseWarm(server.id) },
                                  onChange: { [weak self] id, _ in DispatchQueue.main.async { self?.refresh(id) } })
        self.probes = probes
        rows = DeviceSwitch.rows(servers, currentId: currentId, statuses: [:])
        probes.start(servers, currentId: currentId)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Closed without a switch: the warm links go. Never the current server's, which the pool does not own.
        if navigationController?.isBeingDismissed ?? isBeingDismissed || navigationController?.presentingViewController == nil {
            probes?.stop()
        }
    }

    private func refresh(_ id: String) {
        guard let probes else { return }
        rows = DeviceSwitch.rows(servers, currentId: currentId, statuses: probes.snapshot())
        if let index = rows.firstIndex(where: { $0.id == id }) {
            tableView.reconfigureRows(at: [IndexPath(row: index, section: Section.devices.rawValue)])
        }
    }

    // MARK: - Table

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == Section.devices.rawValue ? rows.count : 2
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        if indexPath.section == Section.actions.rawValue {
            var content = UIListContentConfiguration.cell()
            content.text = indexPath.row == 0 ? "Add a device" : "Manage devices"
            content.image = UIImage(systemName: indexPath.row == 0 ? "plus" : "list.bullet")
            content.textProperties.color = tintColorForActions
            cell.contentConfiguration = content
            cell.accessoryView = nil
            cell.accessoryType = .none
            cell.accessibilityLabel = content.text
            cell.accessibilityTraits = .button
            return cell
        }
        let row = rows[indexPath.row]
        var content = UIListContentConfiguration.subtitleCell()
        content.text = row.label
        content.secondaryText = row.detail
        content.secondaryTextProperties.color = .secondaryLabel
        cell.contentConfiguration = content
        cell.accessoryView = accessory(row)
        cell.isAccessibilityElement = true
        cell.accessibilityLabel = row.accessibilityLabel + (switching == row.id ? ", opening" : "")
        cell.accessibilityTraits = row.current ? [.button, .selected] : .button
        return cell
    }

    private var tintColorForActions: UIColor { view.tintColor ?? .systemBlue }

    /// The dot, or a spinner while this row opens, then the tick on the current one.
    private func accessory(_ row: DeviceSwitch.Row) -> UIView {
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 10
        if switching == row.id {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            stack.addArrangedSubview(spinner)
        } else {
            let dot = UIView()
            dot.backgroundColor = Self.color(row.status)
            dot.layer.cornerRadius = 5
            dot.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 10), dot.heightAnchor.constraint(equalToConstant: 10)])
            stack.addArrangedSubview(dot)
        }
        let tick = UIImageView(image: UIImage(systemName: "checkmark"))
        tick.tintColor = tintColorForActions
        tick.alpha = row.current ? 1 : 0
        stack.addArrangedSubview(tick)
        stack.frame = CGRect(x: 0, y: 0, width: 46, height: 24)
        return stack
    }

    private static func color(_ status: DeviceSwitch.Status) -> UIColor {
        switch status {
        case .connected: return .systemGreen
        case .checking, .offline: return .systemGray
        case .attention: return .systemOrange
        case .blocked: return .systemRed
        }
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard switching == nil, !chosen else { return }
        if indexPath.section == Section.actions.rawValue {
            let route = indexPath.row == 0 ? ShellRoute(screen: ShellConnector.add, serverId: nil) : ShellRoute(screen: ShellConnector.list, serverId: currentId)
            choose(.leave(route))
            return
        }
        let row = rows[indexPath.row]
        if row.current {
            dismiss(animated: true)
            return
        }
        switchTo(row.id, at: indexPath)
    }

    private func switchTo(_ id: String, at indexPath: IndexPath) {
        switching = id
        tableView.reconfigureRows(at: [indexPath])
        let connector = self.connector
        let currentPath = self.currentPath
        let server = connector.server(id)
        Task { @MainActor [weak self] in
            var cookies: String?
            if let server, let url = server.url { cookies = await WebsiteData.cookieHeader(serverId: id, url: url) }
            let outcome = await connector.switchTo(id, cookies: cookies, currentPath: currentPath)
            // Removed by the computer: what the cockpit kept on the phone goes, as on any open.
            if outcome.screen == ShellConnector.deviceRemoved { await WebsiteData.wipe(serverId: id) }
            guard let self, !self.chosen else { return }
            // A failed target lands on the connect page's error screen for it, as any open does.
            if outcome.screen == ShellConnector.open && outcome.url != nil {
                self.choose(.open(outcome), keep: id)
            } else {
                self.choose(.leave(ShellRoute(screen: outcome.screen, serverId: outcome.serverId ?? id)))
            }
        }
    }

    private func choose(_ choice: Choice, keep: String? = nil) {
        chosen = true
        probes?.stop(keep: keep)
        onChoice(choice)
    }
}
