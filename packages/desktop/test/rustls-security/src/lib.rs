// #2393 / GHSA-c8m5-c952-6cm4: exercise the public session-store interface with
// real TLS sessions. Test-only stores inspect Debug output without logging it.
#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read, Write};
    use std::sync::{Arc, Mutex};

    use rustls::client::{
        ClientSessionMemoryCache, ClientSessionStore, Resumption, Tls12ClientSessionValue,
        Tls13ClientSessionValue,
    };
    use rustls::pki_types::{PrivatePkcs8KeyDer, ServerName};
    use rustls::{
        ClientConfig, ClientConnection, HandshakeKind, NamedGroup, RootCertStore, ServerConfig,
        ServerConnection, SupportedProtocolVersion,
    };

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
        let provider = Arc::new(rustls::crypto::ring::default_provider());
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
        for debug in formatted.iter() {
            assert!(debug.contains("ClientSessionCommon"));
            assert!(debug.contains("ticket:") && debug.contains("lifetime_secs:"));
            // Never include the debug value in a failure: on the vulnerable version it is secret.
            assert!(
                !debug.contains("secret:"),
                "session Debug exposed its secret-bearing field"
            );
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
            assert!(matches!(
                exchange(&mut client, &mut server),
                Err(rustls::Error::InvalidCertificate(_))
            ));
            assert!(server.reader().read(&mut [0; 1]).is_err());
        }
    }
}
