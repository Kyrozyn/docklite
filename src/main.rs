mod auth;
mod docker_ops;
mod models;
mod routes;

use axum::{
    http::{header, StatusCode, Uri},
    response::IntoResponse,
    routing::{delete, get, post},
    Router,
};
use docker_ops::DockerManager;
use rust_embed::RustEmbed;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(RustEmbed)]
#[folder = "frontend/"]
struct Assets;

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }

    match Assets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => {
            // SPA fallback: return index.html for unrecognized routes
            if let Some(content) = Assets::get("index.html") {
                ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], content.data).into_response()
            } else {
                (StatusCode::NOT_FOUND, "404 Not Found").into_response()
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Setup logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "docklite=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Initializing DockLite - Lightweight Docker Manager");

    // Initialize Docker Manager
    let docker_mgr = match DockerManager::new() {
        Ok(mgr) => Arc::new(mgr),
        Err(e) => {
            tracing::error!("Failed to connect to Docker daemon: {}", e);
            tracing::error!("Ensure Docker is running and /var/run/docker.sock is accessible.");
            return Err(e.into());
        }
    };

    // Verify Docker daemon connection
    match docker_mgr.get_system_info().await {
        Ok(info) => {
            tracing::info!(
                "Successfully connected to Docker v{} on {}",
                info.docker_version,
                info.os
            );
        }
        Err(e) => {
            tracing::warn!("Warning: Could not fetch initial Docker info: {}", e);
        }
    }

    // Initialize Auth Manager (checks DOCKLITE_PASSWORD / AUTH_PASSWORD in env)
    let auth_mgr = Arc::new(auth::AuthManager::new());

    // Public API routes
    let public_api = Router::new()
        .route("/health", get(routes::health));

    // Authentication endpoints
    let auth_api = Router::new()
        .route("/auth/status", get(routes::auth_status))
        .route("/auth/login", post(routes::auth_login))
        .route("/auth/logout", post(routes::auth_logout))
        .with_state(auth_mgr.clone());

    // Protected Docker Management routes
    let protected_docker_api = Router::new()
        .route("/system/info", get(routes::system_info))
        .route("/system/prune", post(routes::system_prune))
        .route("/containers", get(routes::list_containers))
        .route("/containers/create", post(routes::create_container))
        .route("/containers/{id}", get(routes::inspect_container))
        .route("/containers/{id}/action/{action}", post(routes::container_action))
        .route("/containers/{id}/logs", get(routes::container_logs))
        .route("/containers/{id}/stats", get(routes::container_stats))
        .route("/images", get(routes::list_images))
        .route("/images/pull", post(routes::pull_image))
        .route("/images/{id}", delete(routes::remove_image))
        .route("/volumes", get(routes::list_volumes))
        .route("/volumes/create", post(routes::create_volume))
        .route("/volumes/{name}", delete(routes::remove_volume))
        .route("/networks", get(routes::list_networks))
        .route("/networks/create", post(routes::create_network))
        .route("/networks/{id}", delete(routes::remove_network))
        .with_state(docker_mgr)
        .layer(axum::middleware::from_fn_with_state(
            auth_mgr.clone(),
            routes::auth_middleware,
        ));

    // Build unified API routes
    let api_routes = Router::new()
        .merge(public_api)
        .merge(auth_api)
        .merge(protected_docker_api);

    // Main App router
    let app = Router::new()
        .nest("/api", api_routes)
        .fallback(static_handler)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;

    tracing::info!("DockLite web server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
