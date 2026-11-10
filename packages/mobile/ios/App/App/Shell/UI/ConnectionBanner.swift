import UIKit

/// The banner view for `ConnectionBannerText`, pinned under the top safe area of the server view.
/// A touch on it must not reach the page under it.
final class ConnectionBanner: UIView {
    private let label = UILabel()
    private let retryButton: UIButton
    private let serversButton: UIButton

    /// `onRetry` is the Retry button, `onServers` the Servers one (back to the list), as on Android.
    init(onRetry: @escaping () -> Void, onServers: @escaping () -> Void) {
        func button(_ title: String, _ action: @escaping () -> Void) -> UIButton {
            var configuration = UIButton.Configuration.plain()
            configuration.title = title
            configuration.baseForegroundColor = .white
            return UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        }
        retryButton = button("Retry", onRetry)
        serversButton = button("Servers", onServers)
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0x40 / 255, green: 0x10 / 255, blue: 0x10 / 255, alpha: 0xF0 / 255)
        isUserInteractionEnabled = true
        isHidden = true
        label.textColor = .white
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stack = UIStackView(arrangedSubviews: [label, retryButton, serversButton])
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
        isHidden = false
        superview?.bringSubviewToFront(self)
    }

    func show(_ banner: ConnectionBannerText) {
        show(text: banner.text, retry: banner.retry)
    }

    func hide() {
        isHidden = true
    }
}
