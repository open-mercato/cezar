import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSelfSignedCert, loadOrCreateCert } from './certs.ts';

describe('certs', () => {
  describe('createSelfSignedCert', () => {
    it('creates an X.509 certificate acceptable to node:crypto with SAN and CA:FALSE', () => {
      const hosts = ['localhost', '127.0.0.1', '192.168.1.50'];
      const now = new Date('2026-10-21T00:00:00Z');
      const { cert: certPem, key: keyPem } = createSelfSignedCert({ hosts, days: 365, now });

      const cert = new crypto.X509Certificate(certPem);
      expect(cert.ca).toBe(false);
      expect(cert.subject).toBe('CN=cezar (local)');
      expect(cert.issuer).toBe('CN=cezar (local)');
      expect(cert.verify(cert.publicKey)).toBe(true);

      // SAN checks
      expect(cert.checkHost('localhost')).toBe('localhost');
      expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
      expect(cert.checkIP('192.168.1.50')).toBe('192.168.1.50');
      expect(cert.checkIP('10.0.0.1')).toBeUndefined();
      expect(cert.checkHost('otherhost')).toBeUndefined();

      // Validity ~365 days
      const validFrom = new Date(cert.validFrom);
      const validTo = new Date(cert.validTo);
      const diffMs = validTo.getTime() - now.getTime();
      const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
      expect(diffDays).toBe(365);
      expect(validFrom.getTime()).toBeLessThan(now.getTime());

      // Private key check
      const privKey = crypto.createPrivateKey(keyPem);
      expect(cert.checkPrivateKey(privKey)).toBe(true);
    });

    it('performs a real TLS handshake over loopback without disabling rejectUnauthorized', async () => {
      const hosts = ['127.0.0.1', 'localhost'];
      const { cert, key } = createSelfSignedCert({ hosts });

      const server = tls.createServer({ cert, key }, (socket) => {
        socket.write('handshake-ok');
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
      });

      const port = (server.address() as { port: number }).port;

      try {
        const received = await new Promise<string>((resolve, reject) => {
          const client = tls.connect(
            {
              host: '127.0.0.1',
              port,
              ca: cert,
            },
            () => {
              expect(client.authorized).toBe(true);
              expect(client.authorizationError).toBeNull();
            }
          );

          client.on('data', (data) => {
            client.end();
            resolve(data.toString());
          });
          client.on('error', reject);
        });

        expect(received).toBe('handshake-ok');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('loadOrCreateCert', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-certs-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates certificate and key files on first call', () => {
      const hosts = ['localhost', '127.0.0.1'];
      const material = loadOrCreateCert(tmpDir, hosts);

      const certFile = path.join(tmpDir, 'cezar-cert.pem');
      const keyFile = path.join(tmpDir, 'cezar-key.pem');

      expect(fs.existsSync(certFile)).toBe(true);
      expect(fs.existsSync(keyFile)).toBe(true);
      expect(material.cert).toBe(fs.readFileSync(certFile, 'utf8'));
      expect(material.key).toBe(fs.readFileSync(keyFile, 'utf8'));
      expect(material.fingerprint256).toMatch(/^[0-9A-F:]{95}$/);

      if (process.platform !== 'win32') {
        const keyStat = fs.statSync(keyFile);
        expect(keyStat.mode & 0o777).toBe(0o600);
      }
    });

    it('reuses existing certificate and key when valid and coverage matches', () => {
      const hosts = ['localhost', '127.0.0.1'];
      const first = loadOrCreateCert(tmpDir, hosts);
      const second = loadOrCreateCert(tmpDir, hosts);

      expect(second.fingerprint256).toBe(first.fingerprint256);
      expect(second.cert).toBe(first.cert);
      expect(second.key).toBe(first.key);
    });

    it('regenerates when a new host is added to hosts list', () => {
      const initialHosts = ['localhost', '127.0.0.1'];
      const first = loadOrCreateCert(tmpDir, initialHosts);

      const updatedHosts = ['localhost', '127.0.0.1', '192.168.1.100'];
      const second = loadOrCreateCert(tmpDir, updatedHosts);

      expect(second.fingerprint256).not.toBe(first.fingerprint256);
      const secondCert = new crypto.X509Certificate(second.cert);
      expect(secondCert.checkIP('192.168.1.100')).toBe('192.168.1.100');
    });

    it('regenerates when the certificate is within 30 days of expiry', () => {
      const hosts = ['localhost', '127.0.0.1'];
      const createDate = new Date('2026-01-01T00:00:00Z');
      const first = loadOrCreateCert(tmpDir, hosts, createDate);

      // 340 days later, expiring in ~25 days (< 30 days remaining)
      const nearExpiryDate = new Date(createDate.getTime() + 340 * 24 * 60 * 60 * 1000);
      const second = loadOrCreateCert(tmpDir, hosts, nearExpiryDate);

      expect(second.fingerprint256).not.toBe(first.fingerprint256);
    });

    it('regenerates cleanly when existing files are corrupt or garbage', () => {
      const certFile = path.join(tmpDir, 'cezar-cert.pem');
      const keyFile = path.join(tmpDir, 'cezar-key.pem');

      fs.writeFileSync(certFile, 'NOT_A_VALID_CERT');
      fs.writeFileSync(keyFile, 'NOT_A_VALID_KEY');

      const hosts = ['localhost', '127.0.0.1'];
      const material = loadOrCreateCert(tmpDir, hosts);

      expect(material.cert).toContain('-----BEGIN CERTIFICATE-----');
      expect(material.key).toContain('-----BEGIN PRIVATE KEY-----');
      const certObj = new crypto.X509Certificate(material.cert);
      expect(certObj.checkHost('localhost')).toBe('localhost');
    });
  });
});
