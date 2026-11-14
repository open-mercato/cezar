import AVFoundation
import UIKit

/// Scans one QR code and hands its string back once. It does not parse it: the relay code owns
/// the cezar-pair format. A denied camera or no camera at all is an error string, never a crash.
final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "cezar.qr-scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var completion: ((String?, String?) -> Void)?
    private var started = false

    /// `completion(code, error)` runs once, on the main thread: a code, or nil and why there is none
    /// (nil and nil means the user cancelled).
    init(completion: @escaping (String?, String?) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let prompt = UILabel()
        prompt.text = "Scan the code on your computer"
        prompt.textColor = .white
        prompt.textAlignment = .center
        prompt.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Cancel"
        let cancel = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.finish(code: nil, error: nil) })
        let stack = UIStackView(arrangedSubviews: [prompt, cancel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
    }

    /// Not from viewDidLoad: an early refusal would dismiss a controller still being presented, and lose the callback.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        authorizeThenStart()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
    }

    private func authorizeThenStart() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.start() } else { self?.finish(code: nil, error: Self.denied) }
                }
            }
        default:
            finish(code: nil, error: Self.denied)
        }
    }

    private static let denied = "Camera access is off. Allow it for Cezar in Settings to scan the code."

    private func start() {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else {
            finish(code: nil, error: "This device has no camera to scan with.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            finish(code: nil, error: "The camera could not start.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        queue.async { [session] in session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        for case let code as AVMetadataMachineReadableCodeObject in objects {
            if let value = code.stringValue {
                finish(code: value, error: nil)
                return
            }
        }
    }

    private func stop() {
        queue.async { [session] in if session.isRunning { session.stopRunning() } }
    }

    /// Once: the scan callback can fire again before the session has stopped.
    private func finish(code: String?, error: String?) {
        guard let done = completion else { return }
        completion = nil
        stop()
        dismiss(animated: true) { done(code, error) }
    }
}
