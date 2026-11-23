// #2393 / GHSA-c8m5-c952-6cm4: exercise the public session-store interface with
// real TLS sessions. Test-only stores inspect Debug output without logging it; the
// secrets themselves are captured through the public KeyLog and Hkdf seams.
#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::{Cursor, Read, Write};
    use std::sync::{Arc, Mutex};

    use rustls::client::{
        ClientSessionMemoryCache, ClientSessionStore, Resumption, Tls12ClientSessionValue,
        Tls13ClientSessionValue,
    };
    use rustls::crypto::hmac::Tag;
    use rustls::crypto::tls13::{Hkdf, HkdfExpander, OkmBlock, OutputLengthError};
    use rustls::crypto::CryptoProvider;
    use rustls::pki_types::{PrivatePkcs8KeyDer, ServerName};
    use rustls::{
        CipherSuiteCommon, ClientConfig, ClientConnection, HandshakeKind, KeyLog, NamedGroup,
        RootCertStore, ServerConfig, ServerConnection, SupportedCipherSuite,
        SupportedProtocolVersion, Tls13CipherSuite,
    };

    // The in-memory handshake runs on the test's own thread, so each test sees only its secrets.
    thread_local! {
        static SECRETS: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
    }

    fn record(secret: &[u8]) {
        SECRETS.with(|s| s.borrow_mut().push(secret.to_vec()));
    }

    /// TLS 1.2 master secrets (and TLS 1.3 traffic secrets) as the client derives them.
    #[derive(Debug)]
    struct RecordingKeyLog;

    impl KeyLog for RecordingKeyLog {
        fn log(&self, _label: &str, _client_random: &[u8], secret: &[u8]) {
            record(secret);
        }
        fn will_log(&self, _label: &str) -> bool {
            true
        }
    }

    /// Every HKDF output, which includes the TLS 1.3 resumption PSK a ticket carries.
    struct RecordingHkdf(&'static dyn Hkdf);
    struct RecordingExpander(Box<dyn HkdfExpander>);

    impl Hkdf for RecordingHkdf {
        fn extract_from_zero_ikm(&self, salt: Option<&[u8]>) -> Box<dyn HkdfExpander> {
            Box::new(RecordingExpander(self.0.extract_from_zero_ikm(salt)))
        }
        fn extract_from_secret(&self, salt: Option<&[u8]>, secret: &[u8]) -> Box<dyn HkdfExpander> {
            Box::new(RecordingExpander(self.0.extract_from_secret(salt, secret)))
        }
        fn expander_for_okm(&self, okm: &OkmBlock) -> Box<dyn HkdfExpander> {
            Box::new(RecordingExpander(self.0.expander_for_okm(okm)))
        }
        fn hmac_sign(&self, key: &OkmBlock, message: &[u8]) -> Tag {
            self.0.hmac_sign(key, message)
        }
    }

    impl HkdfExpander for RecordingExpander {
        fn expand_slice(&self, info: &[&[u8]], output: &mut [u8]) -> Result<(), OutputLengthError> {
            self.0.expand_slice(info, output)?;
            record(output);
            Ok(())
        }
        fn expand_block(&self, info: &[&[u8]]) -> OkmBlock {
            let block = self.0.expand_block(info);
            record(block.as_ref());
            block
        }
        fn hash_len(&self) -> usize {
            self.0.hash_len()
        }
    }

    fn recording_provider() -> CryptoProvider {
        let mut provider = rustls::crypto::ring::default_provider();
        for suite in provider.cipher_suites.iter_mut() {
            if let SupportedCipherSuite::Tls13(s) = *suite {
                let hkdf: &'static dyn Hkdf = Box::leak(Box::new(RecordingHkdf(s.hkdf_provider)));
                *suite = SupportedCipherSuite::Tls13(Box::leak(Box::new(Tls13CipherSuite {
                    common: CipherSuiteCommon {
                        suite: s.common.suite,
                        hash_provider: s.common.hash_provider,
                        confidentiality_limit: s.common.confidentiality_limit,
                    },
                    hkdf_provider: hkdf,
                    aead_alg: s.aead_alg,
                    quic: s.quic,
                })));
            }
        }
        provider
    }

    #[derive(Debug)]
    struct CapturingStore {
        inner: ClientSessionMemoryCache,
        formatted: Mutex<Vec<String>>,
    }

    impl ClientSessionStore for CapturingStore {
        fn set_kx_hint(&self, name: ServerName<'static>, group: NamedGroup) {
            self.inner.set_kx_hint(name, group);
        }
        fn kx_hint(&self, name: &ServerName<'_>) -> Option<NamedGroup> {
            self.inner.kx_hint(name)
        }
        fn set_tls12_session(&self, name: ServerName<'static>, value: Tls12ClientSessionValue) {
            self.formatted.lock().unwrap().push(format!("{value:?}"));
            self.inner.set_tls12_session(name, value);
        }
        fn tls12_session(&self, name: &ServerName<'_>) -> Option<Tls12ClientSessionValue> {
            self.inner.tls12_session(name)
        }
        fn remove_tls12_session(&self, name: &ServerName<'static>) {
            self.inner.remove_tls12_session(name);
        }
        fn insert_tls13_ticket(&self, name: ServerName<'static>, value: Tls13ClientSessionValue) {
            self.formatted.lock().unwrap().push(format!("{value:?}"));
            self.inner.insert_tls13_ticket(name, value);
        }
        fn take_tls13_ticket(&self, name: &ServerName<'static>) -> Option<Tls13ClientSessionValue> {
            self.inner.take_tls13_ticket(name)
        }
    }

    fn configs(
        version: &'static SupportedProtocolVersion,
    ) -> (Arc<ClientConfig>, Arc<ServerConfig>, Arc<CapturingStore>) {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(cert.der().clone()).unwrap();
        let provider = Arc::new(recording_provider());
        let store = Arc::new(CapturingStore {
            inner: ClientSessionMemoryCache::new(16),
            formatted: Mutex::new(Vec::new()),
        });
        let mut client = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[version])
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        client.resumption = Resumption::store(store.clone());
        client.key_log = Arc::new(RecordingKeyLog);
        let server = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[version])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
            )
            .unwrap();
        (Arc::new(client), Arc::new(server), store)
    }

    fn exchange(
        client: &mut ClientConnection,
        server: &mut ServerConnection,
    ) -> Result<(), rustls::Error> {
        for _ in 0..32 {
            if client.wants_write() {
                let mut bytes = Vec::new();
                client.write_tls(&mut bytes).unwrap();
                server.read_tls(&mut Cursor::new(bytes)).unwrap();
                server.process_new_packets()?;
            }
            if server.wants_write() {
                let mut bytes = Vec::new();
                server.write_tls(&mut bytes).unwrap();
                client.read_tls(&mut Cursor::new(bytes)).unwrap();
                client.process_new_packets()?;
            }
            if !client.wants_write() && !server.wants_write() {
                assert!(!client.is_handshaking() && !server.is_handshaking());
                return Ok(());
            }
        }
        panic!("TLS exchange did not settle within 32 flights");
    }

    fn connect(client: Arc<ClientConfig>, server: Arc<ServerConfig>) -> ClientConnection {
        let mut client = ClientConnection::new(client, "localhost".try_into().unwrap()).unwrap();
        let mut server = ServerConnection::new(server).unwrap();
        exchange(&mut client, &mut server).unwrap();
        client.writer().write_all(b"ping").unwrap();
        exchange(&mut client, &mut server).unwrap();
        let mut received = [0; 4];
        server.reader().read_exact(&mut received).unwrap();
        assert_eq!(&received, b"ping");
        client
    }

    fn session_debug_is_redacted(version: &'static SupportedProtocolVersion) {
        let (client, server, store) = configs(version);
        connect(client, server);
        let formatted = store.formatted.lock().unwrap();
        assert!(
            !formatted.is_empty(),
            "handshake must populate the real session store"
        );
        let secrets = SECRETS.with(|s| s.borrow().clone());
        assert!(
            !secrets.is_empty(),
            "handshake must derive recorded secrets"
        );
        for debug in formatted.iter() {
            for secret in &secrets {
                let lower: String = secret.iter().map(|b| format!("{b:02x}")).collect();
                let upper: String = secret.iter().map(|b| format!("{b:02X}")).collect();
                // Never include the debug value in a failure: on the vulnerable version it is secret.
                assert!(
                    !debug.contains(&lower)
                        && !debug.contains(&upper)
                        && !debug.contains(&format!("{secret:?}")),
                    "session Debug exposed secret bytes"
                );
            }
        }
    }

    #[test]
    fn tls12_session_debug_redacts_master_secret() {
        session_debug_is_redacted(&rustls::version::TLS12);
    }

    #[test]
    fn tls13_session_debug_redacts_resumption_psk() {
        session_debug_is_redacted(&rustls::version::TLS13);
    }

    fn resumption_still_works(version: &'static SupportedProtocolVersion) {
        let (client, server, _) = configs(version);
        assert_eq!(
            connect(client.clone(), server.clone()).handshake_kind(),
            Some(HandshakeKind::Full)
        );
        assert_eq!(
            connect(client, server).handshake_kind(),
            Some(HandshakeKind::Resumed)
        );
    }

    #[test]
    fn tls12_authenticated_data_and_resumption_work() {
        resumption_still_works(&rustls::version::TLS12);
    }

    #[test]
    fn tls13_authenticated_data_and_resumption_work() {
        resumption_still_works(&rustls::version::TLS13);
    }

    #[test]
    fn certificate_name_mismatch_is_rejected_before_data_delivery() {
        for version in [&rustls::version::TLS12, &rustls::version::TLS13] {
            let (client, server, _) = configs(version);
            let mut client =
                ClientConnection::new(client, "wrong.example".try_into().unwrap()).unwrap();
            let mut server = ServerConnection::new(server).unwrap();
            // Queued before the handshake: it must never reach the server.
            client.writer().write_all(b"ping").unwrap();
            assert!(matches!(
                exchange(&mut client, &mut server),
                Err(rustls::Error::InvalidCertificate(_))
            ));
            while client.wants_write() {
                let mut bytes = Vec::new();
                client.write_tls(&mut bytes).unwrap();
                server.read_tls(&mut Cursor::new(bytes)).unwrap();
                let _ = server.process_new_packets();
            }
            assert!(
                !matches!(server.reader().read(&mut [0; 4]), Ok(n) if n > 0),
                "plaintext reached the server after certificate rejection"
            );
        }
    }
}
