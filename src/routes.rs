use crate::auth::AuthManager;
use crate::docker_ops::DockerManager;
use crate::models::*;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
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
) -> Response {
    let auth_required = auth.is_required();
    let mut authenticated = !auth_required;
    let mut valid_token: Option<String> = None;

    if auth_required {
        if let Some(token) = extract_token(&headers) {
            if auth.validate_token(&token).await {
                authenticated = true;
                valid_token = Some(token);
            }
        }
    }

    if authenticated {
        if let Some(token) = valid_token {
            let cookie = format!("docklite_token={}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly", token);
            (
                StatusCode::OK,
                [(header::SET_COOKIE, cookie)],
                Json(ApiResponse::ok(AuthStatusView {
                    auth_required,
                    authenticated,
                })),
            )
                .into_response()
        } else {
            (
                StatusCode::OK,
                Json(ApiResponse::ok(AuthStatusView {
                    auth_required,
                    authenticated,
                })),
            )
                .into_response()
        }
    } else {
        let clear_cookie = "docklite_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly";
        (
            StatusCode::OK,
            [(header::SET_COOKIE, clear_cookie)],
            Json(ApiResponse::ok(AuthStatusView {
                auth_required,
                authenticated,
            })),
        )
            .into_response()
    }
}

pub async fn auth_login(
    State(auth): State<Arc<AuthManager>>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    match auth.login(&payload.password).await {
        Some(token) => {
            let cookie = format!("docklite_token={}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly", token);
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

    if let Some(q) = req.uri().query() {
        for part in q.split('&') {
            if let Some(tok) = part.strip_prefix("token=")
                && auth.validate_token(tok).await
            {
                return next.run(req).await;
            }
        }
    }

    let clear_cookie = "docklite_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly";
    (
        StatusCode::UNAUTHORIZED,
        [(header::SET_COOKIE, clear_cookie)],
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

pub async fn container_exec(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
    Json(payload): Json<ContainerExecRequest>,
) -> impl IntoResponse {
    match docker
        .exec_container(&id, payload.shell.as_deref(), &payload.command)
        .await
    {
        Ok((output, exit_code)) => (
            StatusCode::OK,
            Json(ApiResponse::ok(ContainerExecResponse { output, exit_code })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::err(e)),
        ),
    }
}

pub async fn container_terminal_ws(
    State(docker): State<SharedState>,
    Path(id): Path<String>,
    Query(query): Query<ContainerTerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let shell = query.shell.unwrap_or_else(|| "/bin/sh".to_string());
    ws.on_upgrade(move |socket| handle_terminal_socket(docker, id, shell, socket))
}

async fn handle_terminal_socket(
    docker: SharedState,
    container_id: String,
    shell: String,
    socket: WebSocket,
) {
    let raw_cmd = shell.trim();
    let cmd_parts: Vec<&str> = if raw_cmd.is_empty() {
        vec!["/bin/sh"]
    } else {
        raw_cmd.split_whitespace().collect()
    };

    let exec_id = match docker.create_exec_interactive(&container_id, &cmd_parts).await {
        Ok(id) => id,
        Err(e) => {
            let mut s = socket;
            let err_msg = format!("\r\n\x1b[31m[Gagal membuat sesi exec: {}]\x1b[0m\r\n", e);
            let _ = s.send(Message::Text(err_msg.into())).await;
            return;
        }
    };

    let start_res = match docker.start_exec_attached(&exec_id).await {
        Ok(res) => res,
        Err(e) => {
            let mut s = socket;
            let err_msg = format!("\r\n\x1b[31m[Gagal memulai sesi exec: {}]\x1b[0m\r\n", e);
            let _ = s.send(Message::Text(err_msg.into())).await;
            return;
        }
    };

    if let bollard::exec::StartExecResults::Attached { mut output, mut input } = start_res {
        let (mut ws_sender, mut ws_receiver) = socket.split();
        let exec_id_resize = exec_id.clone();
        let docker_resize = docker.clone();

        let mut send_task = tokio::spawn(async move {
            while let Some(msg_res) = output.next().await {
                match msg_res {
                    Ok(log) => {
                        let bytes = log.into_bytes();
                        if ws_sender.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let err = format!("\r\n\x1b[31m[Stream error: {}]\x1b[0m\r\n", e);
                        let _ = ws_sender.send(Message::Text(err.into())).await;
                        break;
                    }
                }
            }
        });

        let mut recv_task = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(msg_res) = ws_receiver.next().await {
                let msg = match msg_res {
                    Ok(m) => m,
                    Err(_) => break,
                };

                match msg {
                    Message::Text(text) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if val.get("type").and_then(|v| v.as_str()) == Some("resize") {
                                if let (Some(cols), Some(rows)) = (
                                    val.get("cols").and_then(|v| v.as_u64()),
                                    val.get("rows").and_then(|v| v.as_u64()),
                                ) {
                                    let _ = docker_resize
                                        .resize_exec(&exec_id_resize, cols as _, rows as _)
                                        .await;
                                    continue;
                                }
                            } else if val.get("type").and_then(|v| v.as_str()) == Some("input") {
                                if let Some(data) = val.get("data").and_then(|v| v.as_str()) {
                                    if input.write_all(data.as_bytes()).await.is_err()
                                        || input.flush().await.is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                            }
                        }
                        if input.write_all(text.as_bytes()).await.is_err()
                            || input.flush().await.is_err()
                        {
                            break;
                        }
                    }
                    Message::Binary(bytes) => {
                        if input.write_all(&bytes).await.is_err()
                            || input.flush().await.is_err()
                        {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        tokio::select! {
            _ = (&mut send_task) => {
                recv_task.abort();
            }
            _ = (&mut recv_task) => {
                send_task.abort();
            }
        }
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
