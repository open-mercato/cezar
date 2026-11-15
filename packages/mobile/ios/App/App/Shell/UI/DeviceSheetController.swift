import UIKit

/// The native device switcher over a server page: one plain row per saved computer (its avatar, name and
/// status in words, a tick on the current one or "N need you"), then Add a device and Manage devices
/// (switcher spec "Native list"). Server pages learn nothing of it: it opens from `cezar://servers` and the
/// banner's Devices button, both native.
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
    private let book: DeviceBookStore
    private let onChoice: (Choice) -> Void
    private var servers: [ServerRecord] = []
    private var rows: [DeviceSwitch.Row] = []
    private var probes: DeviceProbes?
    private var switching: String?
    private var chosen = false

    private enum Section: Int, CaseIterable { case devices, actions }

    init(connector: ShellConnector, currentId: String, currentPath: String?, book: DeviceBookStore = ShellServices.devices,
         onChoice: @escaping (Choice) -> Void) {
        self.connector = connector
        self.currentId = currentId
        self.currentPath = currentPath
        self.book = book
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
        let currentId = self.currentId
        book.update { book in
            book.sync(servers)
            book.noted(currentId, online: true, waiting: nil, failed: nil, at: relayNowMs())
        }
        let relay = ShellServices.relay
        let probes = DeviceProbes(relay: DeviceProbes.relayProbe(relay, userAgent: ShellServices.userAgent),
                                  direct: DeviceProbes.directProbe(connector) { server in
                                      guard let url = server.url else { return nil }
                                      return await WebsiteData.cookieHeader(serverId: server.id, url: url)
                                  },
                                  release: { server in relay.releaseWarm(server.id) },
                                  onChange: { [weak self] id, reading in DispatchQueue.main.async { self?.refresh(id, reading) } })
        self.probes = probes
        rows = makeRows([:])
        probes.start(servers, currentId: currentId)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Closed without a switch: the warm links go. Never the current server's, which the pool does not own.
        if navigationController?.isBeingDismissed ?? isBeingDismissed || navigationController?.presentingViewController == nil {
            probes?.stop()
        }
    }

    private func makeRows(_ readings: [String: DeviceSwitch.Reading]) -> [DeviceSwitch.Row] {
        DeviceSwitch.rows(servers, currentId: currentId, readings: readings, book: book.load(), now: relayNowMs())
    }

    /// Keeps what the computer said for next time (its counts, when it was last online), then redraws.
    private func refresh(_ id: String, _ reading: DeviceSwitch.Reading) {
        guard let probes, !chosen else { return }
        let counts = reading.attention
        book.update { book in
            book.noted(id, online: reading.status == .online, waiting: counts?.waiting, failed: counts?.failed, at: relayNowMs())
        }
        if counts != nil { ShellServices.notifier.showBadge(book.load().badge) }
        rows = makeRows(probes.snapshot())
        tableView.reloadSections(IndexSet(integer: Section.devices.rawValue), with: .none)
    }

    // MARK: - Table

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == Section.devices.rawValue ? rows.count : 2
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        if indexPath.section == Section.actions.rawValue {
            let add = indexPath.row == 0
            var content = UIListContentConfiguration.cell()
            content.text = add ? "Add a device" : "Manage devices"
            content.image = UIImage(systemName: add ? "plus" : "gearshape")
            content.imageProperties.tintColor = add ? tintColorForActions : .secondaryLabel
            #if !targetEnvironment(macCatalyst)
            // Under the avatars, so the action words line up with the names.
            content.imageProperties.reservedLayoutWidth = Self.avatarSize
            #endif
            content.textProperties.color = add ? tintColorForActions : .label
            cell.contentConfiguration = content
            cell.accessoryView = nil
            cell.accessoryType = .none
            cell.accessibilityLabel = content.text
            cell.accessibilityTraits = .button
            return cell
        }
        let row = rows[indexPath.row]
        var content = UIListContentConfiguration.subtitleCell()
        content.image = Self.avatar(row)
        content.imageProperties.maximumSize = CGSize(width: Self.avatarSize, height: Self.avatarSize)
        #if !targetEnvironment(macCatalyst)
        content.imageProperties.reservedLayoutWidth = Self.avatarSize
        #endif
        content.text = row.label
        content.secondaryText = row.words
        content.secondaryTextProperties.color = Self.color(row.status)
        cell.contentConfiguration = content
        cell.accessoryView = accessory(row)
        cell.isAccessibilityElement = true
        cell.accessibilityLabel = switching == row.id ? row.switchingLabel : row.accessibilityLabel
        cell.accessibilityTraits = row.current ? [.button, .selected] : .button
        return cell
    }

    private var tintColorForActions: UIColor { view.tintColor ?? .systemBlue }

    private static let avatarSize: CGFloat = 40

    /// A circle in the name's own colour, white initials, or a laptop when the name has none.
    private static func avatar(_ row: DeviceSwitch.Row) -> UIImage {
        let size = CGSize(width: avatarSize, height: avatarSize)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIColor(hex: row.color).setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            if row.initials.isEmpty {
                let glyph = UIImage(systemName: "laptopcomputer", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))?
                    .withTintColor(.white, renderingMode: .alwaysOriginal)
                if let glyph {
                    glyph.draw(at: CGPoint(x: (size.width - glyph.size.width) / 2, y: (size.height - glyph.size.height) / 2))
                }
                return
            }
            let text = NSAttributedString(string: row.initials, attributes: [
                .font: UIFont.systemFont(ofSize: 15, weight: .bold), .foregroundColor: UIColor.white,
            ])
            let bounds = text.size()
            text.draw(at: CGPoint(x: (size.width - bounds.width) / 2, y: (size.height - bounds.height) / 2))
        }
    }

    /// A spinner while this row opens, the tick on the current one, else "N need you" in amber.
    private func accessory(_ row: DeviceSwitch.Row) -> UIView? {
        if switching == row.id {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            return spinner
        }
        if row.current {
            let tick = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(weight: .semibold)))
            tick.tintColor = tintColorForActions
            return tick
        }
        guard let needWords = row.needWords else { return nil }
        let label = UILabel()
        label.text = needWords
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.textColor = .systemOrange
        label.sizeToFit()
        return label
    }

    private static func color(_ status: DeviceSwitch.Status) -> UIColor {
        switch status {
        case .online, .checking: return .secondaryLabel
        case .offline: return .systemGray
        case .other: return .systemOrange
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

private extension UIColor {
    /// `#rrggbb`, as DeviceIdentity's palette.
    convenience init(hex: String) {
        let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
        self.init(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                  blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}
