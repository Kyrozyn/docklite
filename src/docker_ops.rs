use crate::models::*;
use bollard::models::{
    ContainerCreateBody, HostConfig, NetworkCreateRequest, PortBinding, PortMap,
    RestartPolicy, RestartPolicyNameEnum, VolumeCreateRequest, VolumeScopeEnum,
};
use bollard::query_parameters::{
    CreateContainerOptions, CreateImageOptions, ListContainersOptions, ListImagesOptions,
    ListNetworksOptions, ListVolumesOptions, LogsOptions, PruneContainersOptions,
    PruneImagesOptions, PruneNetworksOptions, PruneVolumesOptions, RemoveContainerOptions,
    RemoveImageOptions, RemoveVolumeOptions, RestartContainerOptions, StartContainerOptions,
    StatsOptions, StopContainerOptions,
};
use bollard::Docker;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;

pub struct DockerManager {
    docker: Arc<Docker>,
}

impl DockerManager {
    pub fn new() -> Result<Self, bollard::errors::Error> {
        let docker = Docker::connect_with_socket_defaults()?;
        Ok(Self {
            docker: Arc::new(docker),
        })
    }

    // --- Containers ---

    pub async fn list_containers(&self, all: bool) -> Result<Vec<ContainerSummaryView>, String> {
        let options = Some(ListContainersOptions {
            all,
            ..Default::default()
        });

        let containers = self
            .docker
            .list_containers(options)
            .await
            .map_err(|e| e.to_string())?;

        let list = containers
            .into_iter()
            .map(|c| {
                let id = c.id.unwrap_or_default();
                let short_id = if id.len() >= 12 {
                    id[..12].to_string()
                } else {
                    id.clone()
                };
                let names = c
                    .names
                    .unwrap_or_default()
                    .into_iter()
                    .map(|n| n.trim_start_matches('/').to_string())
                    .collect();

                let ports = c
                    .ports
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| {
                        let typ_str = p
                            .typ
                            .as_ref()
                            .map(|t| format!("{:?}", t).to_lowercase())
                            .unwrap_or_else(|| "tcp".to_string());
                        if let Some(pub_port) = p.public_port {
                            format!(
                                "{}:{}->{}/{}",
                                p.ip.unwrap_or_default(),
                                pub_port,
                                p.private_port,
                                typ_str
                            )
                        } else {
                            format!("{}/{}", p.private_port, typ_str)
                        }
                    })
                    .collect();

                let state = c
                    .state
                    .as_ref()
                    .map(|s| format!("{:?}", s).to_lowercase())
                    .unwrap_or_else(|| "unknown".to_string());

                ContainerSummaryView {
                    id,
                    short_id,
                    names,
                    image: c.image.unwrap_or_default(),
                    state,
                    status: c.status.unwrap_or_default(),
                    created: c.created.unwrap_or_default(),
                    ports,
                }
            })
            .collect();

        Ok(list)
    }

    pub async fn inspect_container(&self, id: &str) -> Result<serde_json::Value, String> {
        let inspect = self
            .docker
            .inspect_container(id, None)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::to_value(inspect).map_err(|e| e.to_string())
    }

    pub async fn container_action(&self, id: &str, action: &str) -> Result<String, String> {
        match action {
            "start" => {
                self.docker
                    .start_container(id, None::<StartContainerOptions>)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container started successfully".to_string())
            }
            "stop" => {
                self.docker
                    .stop_container(id, None::<StopContainerOptions>)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container stopped successfully".to_string())
            }
            "restart" => {
                self.docker
                    .restart_container(id, None::<RestartContainerOptions>)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container restarted successfully".to_string())
            }
            "pause" => {
                self.docker
                    .pause_container(id)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container paused successfully".to_string())
            }
            "unpause" => {
                self.docker
                    .unpause_container(id)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container unpaused successfully".to_string())
            }
            "kill" => {
                self.docker
                    .kill_container(id, None)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container killed successfully".to_string())
            }
            "remove" => {
                let options = Some(RemoveContainerOptions {
                    force: true,
                    v: true,
                    ..Default::default()
                });
                self.docker
                    .remove_container(id, options)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok("Container removed successfully".to_string())
            }
            other => Err(format!("Unknown action: {}", other)),
        }
    }

    pub async fn get_container_logs(&self, id: &str, tail: usize) -> Result<String, String> {
        let tail_str = tail.to_string();
        let options = Some(LogsOptions {
            stdout: true,
            stderr: true,
            tail: tail_str,
            timestamps: true,
            ..Default::default()
        });

        let mut stream = self.docker.logs(id, options);
        let mut logs = String::new();

        while let Some(log_result) = stream.next().await {
            match log_result {
                Ok(output) => {
                    logs.push_str(&output.to_string());
                }
                Err(e) => {
                    logs.push_str(&format!("[Log fetch error: {}]\n", e));
                    break;
                }
            }
        }

        Ok(logs)
    }

    pub async fn exec_container(
        &self,
        id: &str,
        shell: Option<&str>,
        command: &str,
    ) -> Result<(String, Option<i64>), String> {
        use bollard::exec::{CreateExecOptions, StartExecResults};

        let cmd: Vec<&str> = if let Some(sh) = shell {
            let sh_clean = sh.trim();
            if sh_clean.is_empty() {
                vec!["/bin/sh", "-c", command]
            } else {
                vec![sh_clean, "-c", command]
            }
        } else {
            vec!["/bin/sh", "-c", command]
        };

        let exec_options = CreateExecOptions {
            cmd: Some(cmd),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            ..Default::default()
        };

        let exec = self
            .docker
            .create_exec(id, exec_options)
            .await
            .map_err(|e| format!("Failed to create exec: {}", e))?;

        let output_results = self
            .docker
            .start_exec(&exec.id, None)
            .await
            .map_err(|e| format!("Failed to start exec: {}", e))?;

        let mut output_str = String::new();

        if let StartExecResults::Attached { mut output, .. } = output_results {
            while let Some(msg_res) = output.next().await {
                match msg_res {
                    Ok(log) => {
                        output_str.push_str(&log.to_string());
                    }
                    Err(e) => {
                        output_str.push_str(&format!("\n[Error reading stream: {}]", e));
                        break;
                    }
                }
            }
        }

        let inspect = self
            .docker
            .inspect_exec(&exec.id)
            .await
            .map_err(|e| e.to_string())?;

        Ok((output_str, inspect.exit_code))
    }

    pub async fn get_container_stats(&self, id: &str) -> Result<ContainerStatsView, String> {
        let options = Some(StatsOptions {
            stream: false,
            one_shot: true,
        });

        let mut stream = self.docker.stats(id, options);
        if let Some(res) = stream.next().await {
            let stats = res.map_err(|e| e.to_string())?;

            let cpu_delta = stats
                .cpu_stats
                .as_ref()
                .and_then(|c| c.cpu_usage.as_ref())
                .and_then(|u| u.total_usage)
                .unwrap_or(0) as f64
                - stats
                    .precpu_stats
                    .as_ref()
                    .and_then(|c| c.cpu_usage.as_ref())
                    .and_then(|u| u.total_usage)
                    .unwrap_or(0) as f64;

            let system_cpu_delta = stats
                .cpu_stats
                .as_ref()
                .and_then(|c| c.system_cpu_usage)
                .unwrap_or(0) as f64
                - stats
                    .precpu_stats
                    .as_ref()
                    .and_then(|c| c.system_cpu_usage)
                    .unwrap_or(0) as f64;

            let number_cpus = stats
                .cpu_stats
                .as_ref()
                .and_then(|c| c.online_cpus)
                .unwrap_or(1) as f64;

            let cpu_percentage = if system_cpu_delta > 0.0 && cpu_delta > 0.0 {
                (cpu_delta / system_cpu_delta) * number_cpus * 100.0
            } else {
                0.0
            };

            let memory_used = stats
                .memory_stats
                .as_ref()
                .and_then(|m| m.usage)
                .unwrap_or(0);
            let memory_limit = stats
                .memory_stats
                .as_ref()
                .and_then(|m| m.limit)
                .unwrap_or(1);
            let memory_percentage = if memory_limit > 0 {
                (memory_used as f64 / memory_limit as f64) * 100.0
            } else {
                0.0
            };

            let mut rx = 0u64;
            let mut tx = 0u64;
            if let Some(networks) = stats.networks {
                for (_, net) in networks {
                    rx += net.rx_bytes.unwrap_or(0);
                    tx += net.tx_bytes.unwrap_or(0);
                }
            }

            Ok(ContainerStatsView {
                cpu_percentage: (cpu_percentage * 100.0).round() / 100.0,
                memory_used,
                memory_limit,
                memory_percentage: (memory_percentage * 100.0).round() / 100.0,
                network_rx_bytes: rx,
                network_tx_bytes: tx,
            })
        } else {
            Err("Failed to retrieve stats for container".to_string())
        }
    }

    pub async fn create_container(&self, req: CreateContainerRequest) -> Result<String, String> {
        let mut exposed_ports_list = Vec::new();
        let mut port_bindings: PortMap = HashMap::new();

        if let Some(ports) = req.ports {
            for mapping in ports {
                let parts: Vec<&str> = mapping.split(':').collect();
                if parts.len() == 2 {
                    let host_port = parts[0];
                    let cont_port_proto = parts[1];
                    let cont_key = if cont_port_proto.contains('/') {
                        cont_port_proto.to_string()
                    } else {
                        format!("{}/tcp", cont_port_proto)
                    };

                    exposed_ports_list.push(cont_key.clone());
                    let bindings = vec![PortBinding {
                        host_ip: Some("0.0.0.0".to_string()),
                        host_port: Some(host_port.to_string()),
                    }];
                    port_bindings.insert(cont_key, Some(bindings));
                }
            }
        }

        let restart_policy = req.restart_policy.map(|p| match p.as_str() {
            "always" => RestartPolicy {
                name: Some(RestartPolicyNameEnum::ALWAYS),
                maximum_retry_count: None,
            },
            "unless-stopped" => RestartPolicy {
                name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            },
            "on-failure" => RestartPolicy {
                name: Some(RestartPolicyNameEnum::ON_FAILURE),
                maximum_retry_count: Some(5),
            },
            _ => RestartPolicy {
                name: Some(RestartPolicyNameEnum::NO),
                maximum_retry_count: None,
            },
        });

        let host_config = HostConfig {
            port_bindings: Some(port_bindings),
            binds: req.volumes,
            restart_policy,
            ..Default::default()
        };

        let cmd = req.command.map(|c| {
            c.split_whitespace()
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        });

        let body = ContainerCreateBody {
            image: Some(req.image),
            env: req.env,
            cmd,
            exposed_ports: if exposed_ports_list.is_empty() {
                None
            } else {
                Some(exposed_ports_list)
            },
            host_config: Some(host_config),
            ..Default::default()
        };

        let options = Some(CreateContainerOptions {
            name: req.name,
            platform: "".to_string(),
        });

        let res = self
            .docker
            .create_container(options, body)
            .await
            .map_err(|e| e.to_string())?;

        Ok(res.id)
    }

    // --- Images ---

    pub async fn list_images(&self) -> Result<Vec<ImageSummaryView>, String> {
        let options = Some(ListImagesOptions {
            all: true,
            ..Default::default()
        });

        let images = self
            .docker
            .list_images(options)
            .await
            .map_err(|e| e.to_string())?;

        let list = images
            .into_iter()
            .map(|img| {
                let id = img.id;
                let short_id = if id.starts_with("sha256:") && id.len() >= 19 {
                    id[7..19].to_string()
                } else if id.len() >= 12 {
                    id[..12].to_string()
                } else {
                    id.clone()
                };

                ImageSummaryView {
                    id,
                    short_id,
                    repo_tags: img.repo_tags,
                    size: img.size,
                    created: img.created,
                }
            })
            .collect();

        Ok(list)
    }

    pub async fn pull_image(&self, image_name: &str) -> Result<String, String> {
        let options = Some(CreateImageOptions {
            from_image: Some(image_name.to_string()),
            ..Default::default()
        });

        let mut stream = self.docker.create_image(options, None, None);
        let mut last_status = "Image pull started".to_string();

        while let Some(res) = stream.next().await {
            match res {
                Ok(info) => {
                    if let Some(status) = info.status {
                        last_status = status;
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }

        Ok(format!("Pulled successfully: {}", last_status))
    }

    pub async fn remove_image(&self, id: &str, force: bool) -> Result<String, String> {
        let options = Some(RemoveImageOptions {
            force,
            ..Default::default()
        });

        self.docker
            .remove_image(id, options, None)
            .await
            .map_err(|e| e.to_string())?;

        Ok("Image removed successfully".to_string())
    }

    // --- Volumes ---

    pub async fn list_volumes(&self) -> Result<Vec<VolumeSummaryView>, String> {
        let res = self
            .docker
            .list_volumes(None::<ListVolumesOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let volumes = res.volumes.unwrap_or_default();
        let list = volumes
            .into_iter()
            .map(|v| VolumeSummaryView {
                name: v.name,
                driver: v.driver,
                scope: match v.scope {
                    Some(VolumeScopeEnum::LOCAL) => "local".to_string(),
                    Some(VolumeScopeEnum::GLOBAL) => "global".to_string(),
                    _ => "local".to_string(),
                },
                mountpoint: v.mountpoint,
                created_at: v.created_at,
            })
            .collect();

        Ok(list)
    }

    pub async fn create_volume(
        &self,
        name: &str,
        driver: Option<String>,
    ) -> Result<String, String> {
        let request = VolumeCreateRequest {
            name: Some(name.to_string()),
            driver,
            ..Default::default()
        };

        let res = self
            .docker
            .create_volume(request)
            .await
            .map_err(|e| e.to_string())?;

        Ok(res.name)
    }

    pub async fn remove_volume(&self, name: &str) -> Result<String, String> {
        self.docker
            .remove_volume(name, None::<RemoveVolumeOptions>)
            .await
            .map_err(|e| e.to_string())?;

        Ok("Volume removed successfully".to_string())
    }

    // --- Networks ---

    pub async fn list_networks(&self) -> Result<Vec<NetworkSummaryView>, String> {
        let networks = self
            .docker
            .list_networks(None::<ListNetworksOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let list = networks
            .into_iter()
            .map(|n| {
                let id = n.id.unwrap_or_default();
                let short_id = if id.len() >= 12 {
                    id[..12].to_string()
                } else {
                    id.clone()
                };

                let (subnet, gateway) = n
                    .ipam
                    .and_then(|ipam| ipam.config)
                    .and_then(|configs| configs.into_iter().next())
                    .map(|first| (first.subnet, first.gateway))
                    .unwrap_or((None, None));

                NetworkSummaryView {
                    id,
                    short_id,
                    name: n.name.unwrap_or_default(),
                    driver: n.driver.unwrap_or_default(),
                    scope: n.scope.unwrap_or_default(),
                    subnet,
                    gateway,
                    containers_count: 0,
                }
            })
            .collect();

        Ok(list)
    }

    pub async fn create_network(
        &self,
        name: &str,
        driver: Option<String>,
    ) -> Result<String, String> {
        let request = NetworkCreateRequest {
            name: name.to_string(),
            driver,
            ..Default::default()
        };

        let res = self
            .docker
            .create_network(request)
            .await
            .map_err(|e| e.to_string())?;

        Ok(res.id)
    }

    pub async fn remove_network(&self, id: &str) -> Result<String, String> {
        self.docker
            .remove_network(id)
            .await
            .map_err(|e| e.to_string())?;

        Ok("Network removed successfully".to_string())
    }

    // --- System Info & Prune ---

    pub async fn get_system_info(&self) -> Result<SystemInfoView, String> {
        let info = self.docker.info().await.map_err(|e| e.to_string())?;
        let ver = self.docker.version().await.map_err(|e| e.to_string())?;

        Ok(SystemInfoView {
            docker_version: ver.version.unwrap_or_else(|| "Unknown".to_string()),
            api_version: ver.api_version.unwrap_or_else(|| "Unknown".to_string()),
            os: info.operating_system.unwrap_or_else(|| "Unknown".to_string()),
            arch: info.architecture.unwrap_or_else(|| "Unknown".to_string()),
            kernel_version: info
                .kernel_version
                .unwrap_or_else(|| "Unknown".to_string()),
            n_cpu: info.ncpu.unwrap_or(0),
            mem_total: info.mem_total.unwrap_or(0),
            containers_total: info.containers.unwrap_or(0),
            containers_running: info.containers_running.unwrap_or(0),
            containers_stopped: info.containers_stopped.unwrap_or(0),
            containers_paused: info.containers_paused.unwrap_or(0),
            images_count: info.images.unwrap_or(0),
            server_time: info.system_time.unwrap_or_default(),
        })
    }

    pub async fn prune_system(&self) -> Result<serde_json::Value, String> {
        let cont_prune = self
            .docker
            .prune_containers(None::<PruneContainersOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let img_prune = self
            .docker
            .prune_images(None::<PruneImagesOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let vol_prune = self
            .docker
            .prune_volumes(None::<PruneVolumesOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let net_prune = self
            .docker
            .prune_networks(None::<PruneNetworksOptions>)
            .await
            .map_err(|e| e.to_string())?;

        let total_space_reclaimed = cont_prune.space_reclaimed.unwrap_or(0)
            + img_prune.space_reclaimed.unwrap_or(0)
            + vol_prune.space_reclaimed.unwrap_or(0);

        Ok(serde_json::json!({
            "containers_deleted": cont_prune.containers_deleted.unwrap_or_default(),
            "images_deleted": img_prune.images_deleted.unwrap_or_default().len(),
            "volumes_deleted": vol_prune.volumes_deleted.unwrap_or_default(),
            "networks_deleted": net_prune.networks_deleted.unwrap_or_default(),
            "space_reclaimed_bytes": total_space_reclaimed
        }))
    }
}
