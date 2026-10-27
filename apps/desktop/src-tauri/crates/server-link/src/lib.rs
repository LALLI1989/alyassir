//! Talks to the Alyassir server over HTTPS.
//!
//! The server uses a self-signed certificate (SPEC 4.14), so trust is not given by a
//! certificate authority. Instead the user confirms the certificate fingerprint once,
//! and every later connection must present exactly that certificate (pinning).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

pub const DEFAULT_PORT: u16 = 4100;

/// What the UI needs to translate an error into a clear message (ar/fr).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LinkError {
    InvalidAddress,
    Unreachable { detail: String },
    FingerprintMismatch { seen: String },
    NotAlyassir,
    Protocol { detail: String },
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for LinkError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub app: String,
    pub status: String,
    pub database: String,
    pub version: String,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub url: String,
    pub fingerprint: String,
    pub health: Health,
}

/// Accepts what a person types ("192.168.1.50", "192.168.1.50:4100", "https://...")
/// and returns the base URL, always HTTPS, with the default port when none is given.
pub fn normalize_address(input: &str) -> Result<Url, LinkError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(LinkError::InvalidAddress);
    }
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let mut url = Url::parse(&format!("https://{without_scheme}")).map_err(|_| LinkError::InvalidAddress)?;
    if url.host_str().map_or(true, str::is_empty) {
        return Err(LinkError::InvalidAddress);
    }
    if url.port().is_none() {
        url.set_port(Some(DEFAULT_PORT)).map_err(|_| LinkError::InvalidAddress)?;
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// "AB:CD:..." — the same format the installer shows on the server screen.
pub fn format_fingerprint(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

pub fn parse_fingerprint(text: &str) -> Option<Vec<u8>> {
    let hex: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 64 {
        return None;
    }
    (0..64).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}

#[derive(Debug)]
struct FingerprintVerifier {
    pinned: Option<Vec<u8>>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = Sha256::digest(end_entity.as_ref()).to_vec();
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fingerprint.clone());
        }
        match &self.pinned {
            Some(pinned) if *pinned != fingerprint => Err(rustls::Error::General("certificate fingerprint mismatch".into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    // Signatures are still checked properly: the server must own the certificate's private key.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS settings that accept only the pinned certificate (or record it, when probing).
fn tls_config(pinned: Option<Vec<u8>>, seen: Arc<Mutex<Option<Vec<u8>>>>) -> Result<rustls::ClientConfig, LinkError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = FingerprintVerifier { pinned, seen, provider: provider.clone() };
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| LinkError::Protocol { detail: e.to_string() })?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

fn client(pinned: Option<Vec<u8>>, seen: Arc<Mutex<Option<Vec<u8>>>>) -> Result<reqwest::Client, LinkError> {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls_config(pinned, seen)?)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| LinkError::Protocol { detail: e.to_string() })
}

async fn get_health(base: &Url, pinned: Option<Vec<u8>>) -> Result<(Health, Vec<u8>), LinkError> {
    let seen = Arc::new(Mutex::new(None));
    let http = client(pinned.clone(), seen.clone())?;
    let url = base.join("/api/health").map_err(|_| LinkError::InvalidAddress)?;
    let seen_value = || seen.lock().ok().and_then(|s| s.clone());

    let response = match http.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            if let (Some(pinned), Some(seen)) = (&pinned, seen_value()) {
                if *pinned != seen {
                    return Err(LinkError::FingerprintMismatch { seen: format_fingerprint(&seen) });
                }
            }
            return Err(LinkError::Unreachable { detail: e.to_string() });
        }
    };
    let fingerprint = seen_value().ok_or_else(|| LinkError::Protocol { detail: "no certificate".into() })?;
    // 503 still carries a health body ("database unreachable"), which the UI shows.
    let health: Health = response.json().await.map_err(|_| LinkError::NotAlyassir)?;
    if health.app != "alyassir" {
        return Err(LinkError::NotAlyassir);
    }
    Ok((health, fingerprint))
}

/// First contact: learn the fingerprint so the user can compare it with the server screen.
pub async fn probe(address: &str) -> Result<Probe, LinkError> {
    let base = normalize_address(address)?;
    let (health, fingerprint) = get_health(&base, None).await?;
    Ok(Probe { url: base.to_string(), fingerprint: format_fingerprint(&fingerprint), health })
}

/// Every later contact: only the confirmed certificate is accepted.
pub async fn check(url: &str, fingerprint: &str) -> Result<Health, LinkError> {
    let base = normalize_address(url)?;
    let pinned = parse_fingerprint(fingerprint).ok_or(LinkError::InvalidAddress)?;
    get_health(&base, Some(pinned)).await.map(|(health, _)| health)
}

pub mod socket;

/// A confirmed server: every request must meet the pinned certificate.
#[derive(Clone)]
pub struct Server {
    base: Url,
    fingerprint: Vec<u8>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
    http: reqwest::Client,
}

/// An HTTP answer: status and JSON body (Null when empty).
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: serde_json::Value,
}

impl Server {
    pub fn new(url: &str, fingerprint: &str) -> Result<Self, LinkError> {
        let base = normalize_address(url)?;
        let fingerprint = parse_fingerprint(fingerprint).ok_or(LinkError::InvalidAddress)?;
        let seen = Arc::new(Mutex::new(None));
        let http = client(Some(fingerprint.clone()), seen.clone())?;
        Ok(Self { base, fingerprint, seen, http })
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn fingerprint(&self) -> &[u8] {
        &self.fingerprint
    }

    /// Sends one request. Network and certificate problems are errors; HTTP errors are not.
    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        headers: &[(String, String)],
    ) -> Result<Reply, LinkError> {
        if !path.starts_with("/api/") {
            return Err(LinkError::InvalidAddress);
        }
        let url = self.base.join(path).map_err(|_| LinkError::InvalidAddress)?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| LinkError::InvalidAddress)?;
        let mut request = self.http.request(method, url);
        for (name, value) in headers {
            request = request.header(name.as_str(), value.as_str());
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                let seen = self.seen.lock().ok().and_then(|s| s.clone());
                if let Some(seen) = seen {
                    if seen != self.fingerprint {
                        return Err(LinkError::FingerprintMismatch { seen: format_fingerprint(&seen) });
                    }
                }
                return Err(LinkError::Unreachable { detail: e.to_string() });
            }
        };
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|e| LinkError::Unreachable { detail: e.to_string() })?;
        let body = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| LinkError::NotAlyassir)?
        };
        Ok(Reply { status, body })
    }

    pub(crate) fn tls(&self) -> Result<rustls::ClientConfig, LinkError> {
        tls_config(Some(self.fingerprint.clone()), Arc::new(Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_typed_addresses() {
        assert_eq!(normalize_address("192.168.1.50").unwrap().as_str(), "https://192.168.1.50:4100/");
        assert_eq!(normalize_address(" 192.168.1.50:4200 ").unwrap().as_str(), "https://192.168.1.50:4200/");
        assert_eq!(normalize_address("http://pc-serveur:4100/x?y").unwrap().as_str(), "https://pc-serveur:4100/");
        assert_eq!(normalize_address("https://10.0.0.2:4100").unwrap().as_str(), "https://10.0.0.2:4100/");
        assert_eq!(normalize_address(""), Err(LinkError::InvalidAddress));
        assert_eq!(normalize_address("https://"), Err(LinkError::InvalidAddress));
    }

    #[test]
    fn fingerprint_round_trip() {
        let bytes: Vec<u8> = (0u8..32).collect();
        let text = format_fingerprint(&bytes);
        assert!(text.starts_with("00:01:02"));
        assert_eq!(parse_fingerprint(&text), Some(bytes.clone()));
        assert_eq!(parse_fingerprint(&text.to_lowercase().replace(':', " ")), Some(bytes));
        assert_eq!(parse_fingerprint("AB:CD"), None);
    }
}
