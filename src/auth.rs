use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AuthManager {
    password: Option<String>,
    sessions: Arc<RwLock<HashSet<String>>>,
}

impl AuthManager {
    pub fn new() -> Self {
        // Read password from environment: DOCKLITE_PASSWORD or AUTH_PASSWORD
        let password = std::env::var("DOCKLITE_PASSWORD")
            .or_else(|_| std::env::var("AUTH_PASSWORD"))
            .ok()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());

        if password.is_some() {
            tracing::info!("🔒 Authentication is ENABLED (password set via environment)");
        } else {
            tracing::info!("🔓 Authentication is DISABLED (no password set, open access)");
        }

        Self {
            password,
            sessions: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    #[cfg(test)]
    pub fn with_password(password: Option<&str>) -> Self {
        let password = password.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        Self {
            password,
            sessions: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub fn is_required(&self) -> bool {
        self.password.is_some()
    }

    pub async fn validate_token(&self, token: &str) -> bool {
        if !self.is_required() {
            return true;
        }
        let sessions = self.sessions.read().await;
        sessions.contains(token)
    }

    pub async fn login(&self, input_password: &str) -> Option<String> {
        if let Some(ref pass) = self.password {
            if pass == input_password {
                let token = Self::generate_token();
                let mut sessions = self.sessions.write().await;
                sessions.insert(token.clone());
                return Some(token);
            }
            None
        } else {
            // Password not required, return session token
            Some("unprotected".to_string())
        }
    }

    pub async fn logout(&self, token: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(token);
    }

    fn generate_token() -> String {
        let mut bytes = [0u8; 32];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            if f.read_exact(&mut bytes).is_ok() {
                return bytes.iter().map(|b| format!("{:02x}", b)).collect();
            }
        }
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let pid = std::process::id();
        let count = COUNTER.fetch_add(1, Ordering::SeqCst);
        let raw = format!("{}:{}:{}:{:p}", nanos, pid, count, &bytes);
        let hash = raw.bytes().fold(0xcbf29ce484222325u64, |acc, b| {
            acc.wrapping_mul(0x100000001b3).wrapping_add(b as u64)
        });
        format!("{:016x}{:016x}", hash, nanos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_auth_disabled_by_default() {
        let auth = AuthManager::with_password(None);
        assert!(!auth.is_required());
        assert!(auth.validate_token("any-token").await);
        let token = auth.login("any").await;
        assert_eq!(token, Some("unprotected".to_string()));
    }

    #[tokio::test]
    async fn test_auth_enabled_flow() {
        let auth = AuthManager::with_password(Some("secret123"));
        assert!(auth.is_required());

        // Invalid token
        assert!(!auth.validate_token("invalid").await);

        // Wrong password
        assert_eq!(auth.login("wrong").await, None);

        // Correct password
        let token = auth.login("secret123").await.expect("login should succeed");
        assert!(!token.is_empty());
        assert!(auth.validate_token(&token).await);

        // Logout
        auth.logout(&token).await;
        assert!(!auth.validate_token(&token).await);
    }
}
