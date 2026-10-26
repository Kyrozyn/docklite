# 🐳 DockLite

**DockLite** is an ultra-lightweight, high-performance, Rust-based web management interface for Docker. Built with Tokio, Axum, and Bollard, it packages a full-featured management dashboard into a single static binary and minimal Docker container.

---

## ✨ Features

- **🚀 Ultra-Lightweight & Fast**:
  - Binary size: ~12 MB (stripped with LTO).
  - Runtime memory footprint: **< 15 MB RAM** (vs Portainer's 40–80 MB).
  - Single binary with all frontend HTML/CSS/JS embedded via `rust-embed` (no external static server or CDN needed).
- **📦 Container Management**:
  - View all containers with live state indicators (running, stopped, paused).
  - One-click actions: **Start**, **Stop**, **Restart**, **Pause**, **Unpause**, and **Remove**.
  - **Live Resource Stats**: Real-time CPU%, Memory usage/limit progress bar, and Network I/O metrics.
  - **Log Streamer**: Live log viewer with configurable tail lines and clipboard copy.
  - **Container Inspector**: Full inspection metadata in formatted JSON.
  - **Deploy Container**: Modal with port bindings, environment variables, restart policy, volume mounts, and custom commands.
- **🖼️ Image Management**:
  - List cached images with virtual sizes and creation timestamps.
  - Pull images directly from Docker Hub or private registries with live status updates.
  - Remove images (with optional force).
- **💾 Volumes & Networks**:
  - Inspect, create, and remove Docker volumes and custom networks (bridge, host, overlay).
- **🧹 System Prune**:
  - Clean up dangling images, stopped containers, and unused networks with space reclaimed reporting.

---

## 🏃 Quick Start (Docker Based)

### Option 1: Docker CLI (One liner)

Run DockLite directly by mounting the Docker socket:

```bash
docker run -d \
  --name docklite \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docklite:latest
```

Open your browser at **`http://localhost:3000`**.

---

### Option 2: Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  docklite:
    build: .
    container_name: docklite
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      - RUST_LOG=docklite=info
    deploy:
      resources:
        limits:
          memory: 64M
```

Launch with:

```bash
docker compose up -d
```

---

## 🛠️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                        DockLite                        │
│                                                        │
│  ┌───────────────────────┐   ┌───────────────────────┐ │
│  │ Embedded Frontend     │   │ Axum REST API         │ │
│  │ (HTML / CSS / JS SPA) │◄──┤ (Tokio / Hyper)       │ │
│  └───────────────────────┘   └──────────┬────────────┘ │
│                                         │              │
│                              ┌──────────▼────────────┐ │
│                              │ Bollard Docker Client │ │
│                              └──────────┬────────────┘ │
└─────────────────────────────────────────┼──────────────┘
                                          │ UNIX Socket
                               ┌──────────▼────────────┐
                               │ /var/run/docker.sock  │
                               └───────────────────────┘
```

- **Axum 0.8 & Tokio**: High-concurrency async runtime.
- **Bollard 0.21**: Direct Docker Engine API client via UNIX domain socket.
- **Rust-Embed**: Embeds HTML, CSS, and JS SPA assets directly into the binary.
- **Zero Node.js runtime dependency**: Frontend is pure, standards-compliant JS and modern CSS.

---

## 📡 REST API Overview

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Healthcheck endpoint |
| `GET` | `/api/system/info` | Docker daemon system & host info |
| `POST` | `/api/system/prune` | Clean unused Docker resources |
| `GET` | `/api/containers` | List all containers (`?all=true`) |
| `POST` | `/api/containers/create` | Deploy a new container |
| `GET` | `/api/containers/{id}` | Inspect container JSON |
| `POST` | `/api/containers/{id}/action/{act}` | Trigger `start`, `stop`, `restart`, `pause`, `unpause`, `remove` |
| `GET` | `/api/containers/{id}/logs` | Tail container logs (`?tail=100`) |
| `GET` | `/api/containers/{id}/stats` | CPU & memory live utilization |
| `GET` | `/api/images` | List cached images |
| `POST` | `/api/images/pull` | Pull image from registry |
| `DELETE` | `/api/images/{id}` | Delete image (`?force=true`) |
| `GET` | `/api/volumes` | List volumes |
| `POST` | `/api/volumes/create` | Create a volume |
| `DELETE` | `/api/volumes/{name}` | Remove a volume |
| `GET` | `/api/networks` | List networks |
| `POST` | `/api/networks/create` | Create a network |
| `DELETE` | `/api/networks/{id}` | Remove a network |

---

## 💻 Local Development

Prerequisites: Rust 1.85+ and Docker running locally.

```bash
# Clone and enter directory
cd docklite

# Run development server
cargo run
```

Then visit `http://localhost:3000`.

To build the optimized release binary:

```bash
cargo build --release
```

---

## 📄 License

MIT
