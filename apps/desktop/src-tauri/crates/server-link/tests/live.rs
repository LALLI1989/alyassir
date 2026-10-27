//! Runs against a real installed server (used by the Windows installer test on GitHub).
//! Skipped unless ALYASSIR_TEST_URL and ALYASSIR_TEST_FINGERPRINT are set.

use server_link::{check, probe, LinkError};

fn target() -> Option<(String, String)> {
    Some((std::env::var("ALYASSIR_TEST_URL").ok()?, std::env::var("ALYASSIR_TEST_FINGERPRINT").ok()?))
}

#[tokio::test]
async fn probe_shows_the_same_fingerprint_as_the_installer() {
    let Some((url, expected)) = target() else { return };
    let probe = probe(&url).await.expect("probe");
    assert_eq!(probe.fingerprint, expected);
    assert_eq!(probe.health.status, "ok");
    assert_eq!(probe.health.database, "ok");
}

#[tokio::test]
async fn pinned_check_accepts_the_confirmed_certificate() {
    let Some((url, expected)) = target() else { return };
    let health = check(&url, &expected).await.expect("check");
    assert_eq!(health.status, "ok");
}

#[tokio::test]
async fn pinned_check_rejects_another_certificate() {
    let Some((url, expected)) = target() else { return };
    let prefix = if expected.starts_with("00") { "FF" } else { "00" };
    let wrong = format!("{prefix}{}", &expected[2..]);
    match check(&url, &wrong).await {
        Err(LinkError::FingerprintMismatch { seen }) => assert_eq!(seen, expected),
        other => panic!("expected FingerprintMismatch, got {other:?}"),
    }
}

/// Realtime link over the pinned certificate. Needs ALYASSIR_TEST_TOKEN (an access token).
#[tokio::test]
async fn realtime_link_connects_with_a_valid_token_only() {
    let Some((url, fingerprint)) = target() else { return };
    let Ok(token) = std::env::var("ALYASSIR_TEST_TOKEN") else { return };
    let server = server_link::Server::new(&url, &fingerprint).expect("server");

    let mut connected = false;
    let end = tokio::time::timeout(std::time::Duration::from_secs(8), server_link::socket::run(&server, &token, |event| {
        if event == server_link::socket::SocketEvent::Connected {
            connected = true;
        }
    }))
    .await;
    // Still running after 8 seconds = the link stayed up.
    assert!(end.is_err(), "link ended early: {end:?}");
    assert!(connected, "never connected");

    let refused = server_link::socket::run(&server, "not-a-token", |_| {}).await;
    assert_eq!(refused, server_link::socket::SocketEnd::Unauthorized);
}

#[tokio::test]
async fn pinned_requests_reach_the_api() {
    let Some((url, fingerprint)) = target() else { return };
    let server = server_link::Server::new(&url, &fingerprint).expect("server");
    let reply = server.send("GET", "/api/system/info", None, &[]).await.expect("reply");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body["app"], "alyassir");
    assert!(server.send("GET", "/not-api", None, &[]).await.is_err());
}
