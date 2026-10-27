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
