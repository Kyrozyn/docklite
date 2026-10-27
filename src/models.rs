use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ContainerSummaryView {
    pub id: String,
    pub short_id: String,
    pub names: Vec<String>,
    pub image: String,
    pub state: String,
    pub status: String,
    pub created: i64,
    pub ports: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStatusView {
    pub auth_required: bool,
    pub authenticated: bool,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResponse {
    pub token: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateContainerRequest {
    pub image: String,
    pub name: Option<String>,
    pub ports: Option<Vec<String>>,   // e.g. ["8080:80", "443:443"]
    pub env: Option<Vec<String>>,     // e.g. ["KEY=VAL"]
    pub volumes: Option<Vec<String>>, // e.g. ["/host/path:/container/path:ro"]
    pub restart_policy: Option<String>, // "no", "always", "unless-stopped", "on-failure"
    pub command: Option<String>,      // optional shell command string
}

#[derive(Debug, Deserialize)]
pub struct PullImageRequest {
    pub image: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateVolumeRequest {
    pub name: String,
    pub driver: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateNetworkRequest {
    pub name: String,
    pub driver: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfoView {
    pub docker_version: String,
    pub api_version: String,
    pub os: String,
    pub arch: String,
    pub kernel_version: String,
    pub n_cpu: i64,
    pub mem_total: i64,
    pub containers_total: i64,
    pub containers_running: i64,
    pub containers_stopped: i64,
    pub containers_paused: i64,
    pub images_count: i64,
    pub server_time: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ContainerStatsView {
    pub cpu_percentage: f64,
    pub memory_used: u64,
    pub memory_limit: u64,
    pub memory_percentage: f64,
    pub network_rx_bytes: u64,
    pub network_tx_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageSummaryView {
    pub id: String,
    pub short_id: String,
    pub repo_tags: Vec<String>,
    pub size: i64,
    pub created: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VolumeSummaryView {
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub mountpoint: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NetworkSummaryView {
    pub id: String,
    pub short_id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub subnet: Option<String>,
    pub gateway: Option<String>,
    pub containers_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_models() {
        let status = AuthStatusView {
            auth_required: true,
            authenticated: false,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"auth_required\":true"));
        assert!(json.contains("\"authenticated\":false"));

        let login_req: LoginRequest = serde_json::from_str(r#"{"password":"secret"}"#).unwrap();
        assert_eq!(login_req.password, "secret");

        let login_res = LoginResponse {
            token: "tok123".to_string(),
        };
        let res_json = serde_json::to_string(&login_res).unwrap();
        assert!(res_json.contains("\"token\":\"tok123\""));
    }

    #[test]
    fn test_api_response_ok() {
        let resp = ApiResponse::ok("healthy");
        assert!(resp.success);
        assert_eq!(resp.data, Some("healthy"));
        assert!(resp.error.is_none());

        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"data\":\"healthy\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn test_api_response_err() {
        let resp: ApiResponse<()> = ApiResponse::err("failed to start container");
        assert!(!resp.success);
        assert!(resp.data.is_none());
        assert_eq!(resp.error, Some("failed to start container".to_string()));

        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":false"));
        assert!(json.contains("\"error\":\"failed to start container\""));
        assert!(!json.contains("\"data\""));
    }

    #[test]
    fn test_create_container_request_deserialization() {
        let raw = r#"{
            "image": "nginx:alpine",
            "name": "my-nginx",
            "ports": ["8080:80"],
            "env": ["FOO=BAR"],
            "volumes": ["/tmp:/data:ro"],
            "restart_policy": "always",
            "command": "nginx -g 'daemon off;'"
        }"#;

        let req: CreateContainerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.image, "nginx:alpine");
        assert_eq!(req.name, Some("my-nginx".to_string()));
        assert_eq!(req.ports, Some(vec!["8080:80".to_string()]));
        assert_eq!(req.env, Some(vec!["FOO=BAR".to_string()]));
        assert_eq!(req.volumes, Some(vec!["/tmp:/data:ro".to_string()]));
        assert_eq!(req.restart_policy, Some("always".to_string()));
        assert_eq!(req.command, Some("nginx -g 'daemon off;'".to_string()));
    }

    #[test]
    fn test_create_container_minimal_request() {
        let raw = r#"{"image": "alpine"}"#;
        let req: CreateContainerRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.image, "alpine");
        assert!(req.name.is_none());
        assert!(req.ports.is_none());
        assert!(req.env.is_none());
    }

    #[test]
    fn test_system_info_serialization() {
        let info = SystemInfoView {
            docker_version: "27.0.0".to_string(),
            api_version: "1.45".to_string(),
            os: "Linux".to_string(),
            arch: "x86_64".to_string(),
            kernel_version: "6.8.0".to_string(),
            n_cpu: 8,
            mem_total: 16000000000,
            containers_total: 5,
            containers_running: 3,
            containers_stopped: 2,
            containers_paused: 0,
            images_count: 10,
            server_time: "2026-10-26T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        let parsed: SystemInfoView = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.docker_version, "27.0.0");
        assert_eq!(parsed.containers_total, 5);
        assert_eq!(parsed.containers_running, 3);
    }

    #[test]
    fn test_container_stats_serialization() {
        let stats = ContainerStatsView {
            cpu_percentage: 12.34,
            memory_used: 104857600,
            memory_limit: 1073741824,
            memory_percentage: 9.77,
            network_rx_bytes: 1024,
            network_tx_bytes: 2048,
        };

        let json = serde_json::to_string(&stats).unwrap();
        let parsed: ContainerStatsView = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.cpu_percentage, 12.34);
        assert_eq!(parsed.memory_used, 104857600);
        assert_eq!(parsed.memory_percentage, 9.77);
    }
}
