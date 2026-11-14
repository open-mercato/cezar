import UIKit

/// The banner view for `ConnectionBannerText`, pinned under the top safe area of the server view.
/// A touch on it must not reach the page under it.
final class ConnectionBanner: UIView {
    private let label = UILabel()
    private let retryButton: UIButton
    private let serversButton: UIButton
    private let confirmButton: UIButton

    /// `onRetry` is the Retry button, `onServers` the Servers one (back to the list), as on Android.
    /// `onConfirm` is the § 18 reminder's Confirm.
    init(onRetry: @escaping () -> Void, onServers: @escaping () -> Void, onConfirm: @escaping () -> Void = {}) {
        func button(_ title: String, _ action: @escaping () -> Void) -> UIButton {
            var configuration = UIButton.Configuration.plain()
            configuration.title = title
            configuration.baseForegroundColor = .white
            return UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        }
        retryButton = button("Retry", onRetry)
        serversButton = button("Servers", onServers)
        confirmButton = button("Confirm", onConfirm)
        confirmButton.isHidden = true
        super.init(frame: .zero)
        backgroundColor = Self.problem
        isUserInteractionEnabled = true
        isHidden = true
        label.textColor = .white
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stack = UIStackView(arrangedSubviews: [label, retryButton, confirmButton, serversButton])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
        ])
    }

    private static let problem = UIColor(red: 0x40 / 255, green: 0x10 / 255, blue: 0x10 / 255, alpha: 0xF0 / 255)
    /// The § 18 reminder is not a failure, so it is not red.
    private static let reminder = UIColor(red: 0x26 / 255, green: 0x32 / 255, blue: 0x38 / 255, alpha: 0xF0 / 255)

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Adds the banner to `container`, pinned under its safe area top and above its other subviews.
    func install(in container: UIView) {
        translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(self)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            leadingAnchor.constraint(equalTo: container.leadingAnchor),
            trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
    }

    func show(text: String, retry: Bool = false) {
        label.text = text
        retryButton.isHidden = !retry
        confirmButton.isHidden = true
        serversButton.isHidden = false
        backgroundColor = Self.problem
        isHidden = false
        superview?.bringSubviewToFront(self)
    }

    func show(_ banner: ConnectionBannerText) {
        show(text: banner.text, retry: banner.retry)
    }

    /// The gentle § 18 reminder: Confirm only, nothing is wrong yet.
    func showReminder(_ text: String) {
        label.text = text
        retryButton.isHidden = true
        serversButton.isHidden = true
        confirmButton.isHidden = false
        backgroundColor = Self.reminder
        isHidden = false
        superview?.bringSubviewToFront(self)
    }

    func hide() {
        isHidden = true
    }
}
