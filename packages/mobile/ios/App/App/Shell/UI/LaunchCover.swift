import UIKit

/// The launch screen over a server page (Android's LaunchView): the splash, what is happening now,
/// or why it stopped with Retry and Your cezars. Never a black screen with nothing to tap.
final class LaunchCover: UIView {
    private let status = UILabel()
    private let problem = UIStackView()
    private let reason = UILabel()

    init(retry: @escaping () -> Void, servers: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = .black
        // Touches wait for the page under it.
        isUserInteractionEnabled = true
        let splash = UIImageView(image: UIImage(named: "Splash"))
        splash.contentMode = .scaleAspectFill
        splash.clipsToBounds = true
        splash.frame = bounds
        splash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(splash)

        status.textColor = UIColor(white: 1, alpha: 0.7)
        status.font = .preferredFont(forTextStyle: .subheadline)
        status.adjustsFontForContentSizeCategory = true
        status.textAlignment = .center
        status.numberOfLines = 0

        let title = UILabel()
        title.text = "Connection problem"
        title.textColor = .white
        title.font = .preferredFont(forTextStyle: .title3).bold()
        title.textAlignment = .center
        reason.textColor = UIColor(white: 1, alpha: 0.8)
        reason.font = .preferredFont(forTextStyle: .body)
        reason.adjustsFontForContentSizeCategory = true
        reason.textAlignment = .center
        reason.numberOfLines = 0
        let buttons = UIStackView(arrangedSubviews: [Self.button("Retry", filled: true, retry), Self.button("Your cezars", filled: false, servers)])
        buttons.spacing = 12
        buttons.distribution = .fillEqually
        problem.axis = .vertical
        problem.alignment = .fill
        problem.spacing = 12
        [title, reason, buttons].forEach(problem.addArrangedSubview)
        problem.isHidden = true

        for view in [status, problem] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        let guide = safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            status.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -56),
            problem.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            problem.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            problem.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -32),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(status text: String?) {
        problem.isHidden = true
        status.isHidden = false
        if status.text != text { status.text = text }
    }

    func show(problem text: String?) {
        status.isHidden = true
        reason.text = text
        problem.isHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: reason)
    }

    private static func button(_ title: String, filled: Bool, _ action: @escaping () -> Void) -> UIButton {
        var configuration = filled ? UIButton.Configuration.filled() : UIButton.Configuration.gray()
        configuration.title = title
        configuration.cornerStyle = .large
        configuration.buttonSize = .large
        if filled {
            configuration.baseBackgroundColor = .white
            configuration.baseForegroundColor = .black
        } else {
            configuration.baseForegroundColor = .white
        }
        return UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
    }
}

private extension UIFont {
    func bold() -> UIFont {
        fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: 0) } ?? self
    }
}
