import UIKit

/// The opaque lock screen. It also covers the window in the app switcher, so no snapshot shows a
/// server page (spec QR3).
final class LockShield: UIView {
    private let message = UILabel()

    init(unlock: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 13 / 255, green: 13 / 255, blue: 13 / 255, alpha: 1)
        // A touch must never reach what is behind, even for the frame before it hides.
        isUserInteractionEnabled = true
        accessibilityViewIsModal = true

        let title = UILabel()
        title.text = "Cezar is locked"
        title.textColor = .white
        title.font = .systemFont(ofSize: 22)
        title.textAlignment = .center
        message.textColor = .white
        message.font = .systemFont(ofSize: 14)
        message.textAlignment = .center
        message.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Unlock"
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in unlock() })

        let stack = UIStackView(arrangedSubviews: [title, message, button])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ text: String) {
        message.text = text
    }
}
