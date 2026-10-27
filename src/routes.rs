use crate::auth::AuthManager;
use crate::docker_ops::DockerManager;
use crate::models::*;
use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::sync::Arc;

pub type SharedState = Arc<DockerManager>;

#[derive(Deserialize)]
pub struct ContainerListQuery {
    pub all: Option<bool>,
}

#[derive(Deserialize)]
pub struct LogsQuery {
    pub tail: Option<usize>,
}

#[derive(Deserialize)]
pub struct RemoveImageQuery {
    pub force: Option<bool>,
}

pub async fn health() -> impl IntoResponse {
    Json(ApiResponse::ok("DockLite is running healthy"))
}

// Authentication
pub fn extract_bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .map(|h| {
            let h = h.trim();
            if let Some(token) = h.strip_prefix("Bearer ") {
                token.trim().to_string()
            } else if let Some(token) = h.strip_prefix("bearer ") {
                token.trim().to_string()
            } else {
                h.to_string()
            }
        })
}

pub fn extract_token(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(token) = extract_bearer_token(headers) {
        if !token.is_empty() {
            return Some(token);
        }
    }
    if let Some(cookie_hdr) = headers.get(header::COOKIE).and_then(|c| c.to_str().ok()) {
        for cookie in cookie_hdr.split(';') {
            let cookie = cookie.trim();
            if let Some(val) = cookie.strip_prefix("docklite_token=") {
                let token = val.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

pub async fn auth_status(
    State(auth): State<Arc<AuthManager>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let auth_required = auth.is_required();
    let mut authenticated = !auth_required;

    if auth_required
        && let Some(token) = extract_token(&headers)
        && auth.validate_token(&token).await
    {
        authenticated = true;
    }

    Json(ApiResponse::ok(AuthStatusView {
        auth_required,
        authenticated,
    }))
}

pub async fn auth_login(
    State(auth): State<Arc<AuthManager>>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    match auth.login(&payload.password).await {
        Some(token) => {
            let cookie = format!("docklite_token={}; Path=/; SameSite=Lax; HttpOnly", token);
            (
                StatusCode::OK,
                [(header::SET_COOKIE, cookie)],
                Json(ApiResponse::ok(LoginResponse { token })),
            )
                .into_response()
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse::<()>::err("Invalid password")),
        )
            .into_response(),
    }
}

pub async fn auth_logout(
    State(auth): State<Arc<AuthManager>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Some(token) = extract_token(&headers) {
        auth.logout(&token).await;
    }
    let cookie = "docklite_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly";
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(ApiResponse::ok("Logged out successfully")),
    )
        .into_response()
}

pub async fn auth_middleware(
    State(auth): State<Arc<AuthManager>>,
    req: Request,
    next: Next,
) -> Response {
    if !auth.is_required() {
        return next.run(req).await;
    }

    if let Some(token) = extract_token(req.headers())
        && auth.validate_token(&token).await
    {
        return next.run(req).await;
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(ApiResponse::<()>::err("Unauthorized: authentication required")),
    )
        .into_response()
}

// Containers
pub async fn list_containers(
    State(docker): State<SharedState>,
    Query(query): Query<ContainerListQuery>,
) -> impl IntoResponse {
    let all = query.all.unwrap_or(true);
    match docker.list_containers(all).await {
        Ok(list) => (StatusCode::OK, Json(ApiResponse::ok(list))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn inspect_container(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match docker.inspect_container(&id).await {
        Ok(details) => (StatusCode::OK, Json(ApiResponse::ok(details))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn container_action(
    State(docker): State<SharedState>,
    Path((id, action)): Path<(String, String)>,
) -> impl IntoResponse {
    match docker.container_action(&id, &action).await {
        Ok(msg) => (StatusCode::OK, Json(ApiResponse::ok(msg))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn container_logs(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> impl IntoResponse {
    let tail = query.tail.unwrap_or(100);
    match docker.get_container_logs(&id, tail).await {
        Ok(logs) => (StatusCode::OK, Json(ApiResponse::ok(logs))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn container_stats(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match docker.get_container_stats(&id).await {
        Ok(stats) => (StatusCode::OK, Json(ApiResponse::ok(stats))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn create_container(
    State(docker): State<SharedState>,
    Json(payload): Json<CreateContainerRequest>,
) -> impl IntoResponse {
    match docker.create_container(payload).await {
        Ok(id) => (
            StatusCode::CREATED,
            Json(ApiResponse::ok(serde_json::json!({ "id": id }))),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

// Images
pub async fn list_images(State(docker): State<SharedState>) -> impl IntoResponse {
    match docker.list_images().await {
        Ok(list) => (StatusCode::OK, Json(ApiResponse::ok(list))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn pull_image(
    State(docker): State<SharedState>,
    Json(payload): Json<PullImageRequest>,
) -> impl IntoResponse {
    match docker.pull_image(&payload.image).await {
        Ok(msg) => (StatusCode::OK, Json(ApiResponse::ok(msg))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn remove_image(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
    Query(query): Query<RemoveImageQuery>,
) -> impl IntoResponse {
    let force = query.force.unwrap_or(false);
    match docker.remove_image(&id, force).await {
        Ok(msg) => (StatusCode::OK, Json(ApiResponse::ok(msg))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

// Volumes
pub async fn list_volumes(State(docker): State<SharedState>) -> impl IntoResponse {
    match docker.list_volumes().await {
        Ok(list) => (StatusCode::OK, Json(ApiResponse::ok(list))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn create_volume(
    State(docker): State<SharedState>,
    Json(payload): Json<CreateVolumeRequest>,
) -> impl IntoResponse {
    match docker.create_volume(&payload.name, payload.driver).await {
        Ok(name) => (
            StatusCode::CREATED,
            Json(ApiResponse::ok(serde_json::json!({ "name": name }))),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn remove_volume(
    State(docker): State<SharedState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match docker.remove_volume(&name).await {
        Ok(msg) => (StatusCode::OK, Json(ApiResponse::ok(msg))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

// Networks
pub async fn list_networks(State(docker): State<SharedState>) -> impl IntoResponse {
    match docker.list_networks().await {
        Ok(list) => (StatusCode::OK, Json(ApiResponse::ok(list))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn create_network(
    State(docker): State<SharedState>,
    Json(payload): Json<CreateNetworkRequest>,
) -> impl IntoResponse {
    match docker.create_network(&payload.name, payload.driver).await {
        Ok(id) => (
            StatusCode::CREATED,
            Json(ApiResponse::ok(serde_json::json!({ "id": id }))),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn remove_network(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match docker.remove_network(&id).await {
        Ok(msg) => (StatusCode::OK, Json(ApiResponse::ok(msg))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

// System
pub async fn system_info(State(docker): State<SharedState>) -> impl IntoResponse {
    match docker.get_system_info().await {
        Ok(info) => (StatusCode::OK, Json(ApiResponse::ok(info))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn system_prune(State(docker): State<SharedState>) -> impl IntoResponse {
    match docker.prune_system().await {
        Ok(summary) => (StatusCode::OK, Json(ApiResponse::ok(summary))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn test_extract_token() {
        let mut headers = HeaderMap::new();
        assert_eq!(extract_token(&headers), None);

        // Bearer uppercase
        headers.insert(header::AUTHORIZATION, "Bearer my-secret-token".parse().unwrap());
        assert_eq!(extract_token(&headers), Some("my-secret-token".to_string()));

        // Bearer lowercase
        headers.insert(header::AUTHORIZATION, "bearer lower-token".parse().unwrap());
        assert_eq!(extract_token(&headers), Some("lower-token".to_string()));

        // From Cookie
        headers.remove(header::AUTHORIZATION);
        headers.insert(header::COOKIE, "other=val; docklite_token=cookie-secret; foo=bar".parse().unwrap());
        assert_eq!(extract_token(&headers), Some("cookie-secret".to_string()));
    }
}
