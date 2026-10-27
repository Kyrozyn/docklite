// DockLite Frontend Management Engine
let currentTab = 'dashboard';
let activeLogsContainerId = null;
let activeStatsContainerId = null;
let statsInterval = null;
let autoRefreshTimer = null;

// State cache
let cachedContainers = [];
let cachedImages = [];
let cachedVolumes = [];
let cachedNetworks = [];
let cachedSystem = null;

let containerFilter = 'all';

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupEventListeners();
  const allowed = await checkAuth();
  if (!allowed) {
    window.location.replace('/login');
    return;
  }
  loadAllData();
  setupAutoRefresh();
});

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Filter buttons for containers
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      containerFilter = e.target.getAttribute('data-filter');
      renderContainersTable();
    });
  });
}

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `tab-${tabName}`);
  });

  const titles = {
    dashboard: 'Dashboard',
    containers: 'Containers',
    images: 'Images',
    volumes: 'Volumes',
    networks: 'Networks'
  };
  document.getElementById('page-title').textContent = titles[tabName] || 'Dashboard';
}

function setupEventListeners() {
  document.getElementById('btn-manual-refresh').addEventListener('click', () => {
    loadAllData();
    showToast('Refreshed data', 'info');
  });

  document.getElementById('auto-refresh-select').addEventListener('change', setupAutoRefresh);

  // Search input listeners
  document.getElementById('containers-search').addEventListener('input', renderContainersTable);
  document.getElementById('images-search').addEventListener('input', renderImagesTable);
  document.getElementById('volumes-search').addEventListener('input', renderVolumesTable);
  document.getElementById('networks-search').addEventListener('input', renderNetworksTable);

  // Logout buttons
  document.querySelectorAll('.btn-logout-action').forEach(btn => {
    btn.addEventListener('click', handleLogout);
  });
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const interval = parseInt(document.getElementById('auto-refresh-select').value, 10);
  if (interval > 0) {
    autoRefreshTimer = setInterval(() => {
      loadAllData(false);
    }, interval);
  }
}

// Authentication State & Handlers
let authRequired = false;

function updateLogoutButtons(show) {
  document.querySelectorAll('.btn-logout-action').forEach(btn => {
    btn.classList.toggle('hidden', !show);
  });
}

async function checkAuth() {
  const token = localStorage.getItem('docklite_token') || '';
  if (token) {
    updateLogoutButtons(true);
  }
  try {
    const res = await fetch('/api/auth/status', {
      headers: token ? {
        'Authorization': `Bearer ${token}`
      } : {}
    });
    const json = await res.json();
    if (json.success && json.data) {
      authRequired = json.data.auth_required;
      const authenticated = json.data.authenticated;

      if (authRequired) {
        if (!authenticated) {
          localStorage.removeItem('docklite_token');
          updateLogoutButtons(false);
          return false;
        } else {
          updateLogoutButtons(true);
        }
      } else if (token) {
        updateLogoutButtons(true);
      } else {
        updateLogoutButtons(false);
      }
    }
    return true;
  } catch (err) {
    console.error('Failed to verify auth status:', err);
    localStorage.removeItem('docklite_token');
    updateLogoutButtons(false);
    return false;
  }
}

async function handleLogout() {
  const token = localStorage.getItem('docklite_token') || '';
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? {
        'Authorization': `Bearer ${token}`
      } : {}
    });
  } catch (e) {
    console.warn(e);
  }
  localStorage.removeItem('docklite_token');
  window.location.replace('/login');
}

// API Helpers
async function apiCall(endpoint, options = {}) {
  const token = localStorage.getItem('docklite_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(endpoint, {
      ...options,
      headers
    });

    if (res.status === 401 && endpoint !== '/api/auth/login' && endpoint !== '/api/auth/status') {
      localStorage.removeItem('docklite_token');
      window.location.replace('/login');
      throw new Error('Authentication required');
    }

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data.data;
  } catch (err) {
    console.error(`API Error on ${endpoint}:`, err);
    throw err;
  }
}

// Data loaders
async function loadAllData(showLoading = true) {
  try {
    await Promise.all([
      fetchSystemInfo(),
      fetchContainers(),
      fetchImages(),
      fetchVolumes(),
      fetchNetworks()
    ]);
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

async function fetchSystemInfo() {
  try {
    const info = await apiCall('/api/system/info');
    cachedSystem = info;
    document.getElementById('docker-version-str').textContent = `v${info.docker_version}`;
    document.getElementById('dash-containers-total').textContent = info.containers_total;
    document.getElementById('dash-containers-running').textContent = info.containers_running;
    document.getElementById('dash-containers-stopped').textContent = info.containers_stopped;
    document.getElementById('dash-containers-paused').textContent = info.containers_paused;
    document.getElementById('dash-images-count').textContent = info.images_count;

    document.getElementById('sys-os').textContent = info.os;
    document.getElementById('sys-arch').textContent = info.arch;
    document.getElementById('sys-kernel').textContent = info.kernel_version;
    document.getElementById('sys-cpus').textContent = info.n_cpu;
    document.getElementById('sys-mem').textContent = formatBytes(info.mem_total);
    document.getElementById('sys-api').textContent = info.api_version;
  } catch (e) {
    document.getElementById('docker-version-str').textContent = 'Disconnected';
  }
}

async function fetchContainers() {
  try {
    const list = await apiCall('/api/containers?all=true');
    cachedContainers = list;
    document.getElementById('sidebar-container-count').textContent = list.length;
    renderContainersTable();
    renderDashboardContainers();
  } catch (err) {
    document.getElementById('containers-list').innerHTML = `<tr><td colspan="7" class="text-center">Error loading containers: ${err.message}</td></tr>`;
  }
}

async function fetchImages() {
  try {
    const list = await apiCall('/api/images');
    cachedImages = list;
    document.getElementById('sidebar-image-count').textContent = list.length;
    document.getElementById('dash-images-count').textContent = list.length;
    renderImagesTable();
  } catch (err) {
    document.getElementById('images-list').innerHTML = `<tr><td colspan="5" class="text-center">Error loading images: ${err.message}</td></tr>`;
  }
}

async function fetchVolumes() {
  try {
    const list = await apiCall('/api/volumes');
    cachedVolumes = list;
    document.getElementById('dash-volumes-count').textContent = list.length;
    renderVolumesTable();
  } catch (err) {
    document.getElementById('volumes-list').innerHTML = `<tr><td colspan="5" class="text-center">Error loading volumes: ${err.message}</td></tr>`;
  }
}

async function fetchNetworks() {
  try {
    const list = await apiCall('/api/networks');
    cachedNetworks = list;
    document.getElementById('dash-networks-count').textContent = list.length;
    renderNetworksTable();
  } catch (err) {
    document.getElementById('networks-list').innerHTML = `<tr><td colspan="6" class="text-center">Error loading networks: ${err.message}</td></tr>`;
  }
}

// Renderers
function renderDashboardContainers() {
  const tbody = document.getElementById('dash-containers-list');
  if (cachedContainers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">No containers found.</td></tr>`;
    return;
  }

  const items = cachedContainers.slice(0, 5);
  tbody.innerHTML = items.map(c => {
    const name = c.names[0] || c.short_id;
    return `
      <tr>
        <td><span class="status-pill status-${c.state.toLowerCase()}">${c.state}</span></td>
        <td><span class="cell-title" onclick="inspectContainer('${c.id}')">${name}</span></td>
        <td class="cell-sub">${c.image}</td>
        <td>${c.status}</td>
        <td class="cell-sub">${c.ports.join(', ') || '-'}</td>
        <td>
          <div class="btn-action-group">
            ${c.state === 'running' 
              ? `<button class="btn-action" title="Stop" onclick="containerAction('${c.id}', 'stop')">⏹</button>`
              : `<button class="btn-action btn-action-success" title="Start" onclick="containerAction('${c.id}', 'start')">▶</button>`
            }
            <button class="btn-action" title="Logs" onclick="openLogs('${c.id}', '${name}')">📄</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderContainersTable() {
  const tbody = document.getElementById('containers-list');
  const search = (document.getElementById('containers-search').value || '').toLowerCase();

  let filtered = cachedContainers.filter(c => {
    if (containerFilter === 'running' && c.state !== 'running') return false;
    if (containerFilter === 'exited' && c.state !== 'exited') return false;
    if (search) {
      const matchName = c.names.some(n => n.toLowerCase().includes(search));
      const matchImg = c.image.toLowerCase().includes(search);
      const matchId = c.short_id.toLowerCase().includes(search);
      return matchName || matchImg || matchId;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">No matching containers found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const name = c.names[0] || c.short_id;
    const isRunning = c.state === 'running';
    const isPaused = c.state === 'paused';

    return `
      <tr>
        <td><span class="status-pill status-${c.state.toLowerCase()}">${c.state}</span></td>
        <td>
          <span class="cell-title" onclick="inspectContainer('${c.id}')">${name}</span>
          <div class="cell-sub">${c.short_id}</div>
        </td>
        <td class="cell-sub">${c.image}</td>
        <td>${c.status}</td>
        <td class="cell-sub">${c.ports.join(', ') || '-'}</td>
        <td class="cell-sub">${formatTimestamp(c.created)}</td>
        <td class="text-right">
          <div class="btn-action-group">
            ${isRunning 
              ? `<button class="btn-action" title="Stop" onclick="containerAction('${c.id}', 'stop')">⏹</button>
                 <button class="btn-action" title="Restart" onclick="containerAction('${c.id}', 'restart')">↻</button>
                 <button class="btn-action" title="Pause" onclick="containerAction('${c.id}', 'pause')">⏸</button>`
              : isPaused 
                ? `<button class="btn-action btn-action-success" title="Unpause" onclick="containerAction('${c.id}', 'unpause')">▶</button>`
                : `<button class="btn-action btn-action-success" title="Start" onclick="containerAction('${c.id}', 'start')">▶</button>`
            }
            <button class="btn-action" title="Logs" onclick="openLogs('${c.id}', '${name}')">📄</button>
            ${isRunning ? `<button class="btn-action" title="Stats" onclick="openStats('${c.id}', '${name}')">📊</button>` : ''}
            <button class="btn-action btn-action-danger" title="Remove" onclick="removeContainer('${c.id}', '${name}')">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderImagesTable() {
  const tbody = document.getElementById('images-list');
  const search = (document.getElementById('images-search').value || '').toLowerCase();

  let filtered = cachedImages.filter(img => {
    if (!search) return true;
    const matchTag = img.repo_tags.some(t => t.toLowerCase().includes(search));
    const matchId = img.short_id.toLowerCase().includes(search);
    return matchTag || matchId;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">No images found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(img => {
    const tags = img.repo_tags.length ? img.repo_tags.join(', ') : '<none>';
    const primaryTag = img.repo_tags[0] || '';
    return `
      <tr>
        <td>
          <div class="cell-title">${tags}</div>
        </td>
        <td class="cell-sub">${img.short_id}</td>
        <td>${formatBytes(img.size)}</td>
        <td class="cell-sub">${formatTimestamp(img.created)}</td>
        <td class="text-right">
          <div class="btn-action-group">
            ${primaryTag && primaryTag !== '<none>' ? `
              <button class="btn-action btn-action-success" title="Deploy" onclick="deployFromImage('${primaryTag}')">▶ Run</button>
            ` : ''}
            <button class="btn-action btn-action-danger" title="Remove Image" onclick="removeImage('${img.id}')">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderVolumesTable() {
  const tbody = document.getElementById('volumes-list');
  const search = (document.getElementById('volumes-search').value || '').toLowerCase();

  let filtered = cachedVolumes.filter(v => {
    if (!search) return true;
    return v.name.toLowerCase().includes(search) || v.driver.toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">No volumes found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(v => `
    <tr>
      <td><span class="cell-title">${v.name}</span></td>
      <td><span class="tag tag-gray">${v.driver}</span></td>
      <td>${v.scope}</td>
      <td class="cell-sub">${v.mountpoint}</td>
      <td class="text-right">
        <button class="btn-action btn-action-danger" title="Remove Volume" onclick="removeVolume('${v.name}')">🗑</button>
      </td>
    </tr>
  `).join('');
}

function renderNetworksTable() {
  const tbody = document.getElementById('networks-list');
  const search = (document.getElementById('networks-search').value || '').toLowerCase();

  let filtered = cachedNetworks.filter(n => {
    if (!search) return true;
    return n.name.toLowerCase().includes(search) || n.driver.toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">No networks found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(n => `
    <tr>
      <td><span class="cell-title">${n.name}</span></td>
      <td><span class="tag tag-gray">${n.driver}</span></td>
      <td>${n.scope}</td>
      <td class="cell-sub">${n.subnet ? `${n.subnet} (${n.gateway || 'no gw'})` : '-'}</td>
      <td>${n.containers_count} connected</td>
      <td class="text-right">
        ${!['bridge', 'host', 'none'].includes(n.name) ? `
          <button class="btn-action btn-action-danger" title="Remove Network" onclick="removeNetwork('${n.id}', '${n.name}')">🗑</button>
        ` : '<span class="cell-sub">system</span>'}
      </td>
    </tr>
  `).join('');
}

// Container Actions
async function containerAction(id, action) {
  try {
    showToast(`Executing ${action}...`, 'info');
    const msg = await apiCall(`/api/containers/${id}/action/${action}`, { method: 'POST' });
    showToast(msg || 'Success', 'success');
    await fetchContainers();
    await fetchSystemInfo();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function removeContainer(id, name) {
  if (!confirm(`Are you sure you want to remove container "${name}"?`)) return;
  await containerAction(id, 'remove');
}

// Create Container
async function handleCreateContainer(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-submit-container');
  btn.disabled = true;
  btn.textContent = 'Deploying...';

  const image = document.getElementById('create-c-image').value.trim();
  const name = document.getElementById('create-c-name').value.trim() || undefined;
  const restart = document.getElementById('create-c-restart').value;
  const cmd = document.getElementById('create-c-cmd').value.trim() || undefined;

  const rawPorts = document.getElementById('create-c-ports').value.trim();
  const ports = rawPorts ? rawPorts.split(',').map(s => s.trim()).filter(Boolean) : undefined;

  const rawEnv = document.getElementById('create-c-env').value.trim();
  const env = rawEnv ? rawEnv.split('\n').map(s => s.trim()).filter(Boolean) : undefined;

  const rawVols = document.getElementById('create-c-volumes').value.trim();
  const volumes = rawVols ? rawVols.split('\n').map(s => s.trim()).filter(Boolean) : undefined;

  try {
    const payload = { image, name, ports, env, volumes, restart_policy: restart, command: cmd };
    const res = await apiCall('/api/containers/create', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    showToast('Container created! Starting...', 'info');
    // Start newly created container automatically
    await apiCall(`/api/containers/${res.id}/action/start`, { method: 'POST' });
    showToast('Container deployed & started successfully!', 'success');

    closeModal('modal-create-container');
    document.getElementById('form-create-container').reset();
    await fetchContainers();
    await fetchSystemInfo();
    switchTab('containers');
  } catch (err) {
    showToast(`Deploy failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deploy';
  }
}

function deployFromImage(imageName) {
  document.getElementById('create-c-image').value = imageName;
  openModal('modal-create-container');
}

// Pull Image
async function handlePullImage(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-submit-pull');
  const statusBox = document.getElementById('pull-status-box');
  const imageName = document.getElementById('pull-image-name').value.trim();

  btn.disabled = true;
  btn.textContent = 'Pulling...';
  statusBox.classList.remove('hidden');
  statusBox.textContent = `Initiating pull for "${imageName}"...\nPlease wait, this may take a moment.`;

  try {
    const res = await apiCall('/api/images/pull', {
      method: 'POST',
      body: JSON.stringify({ image: imageName })
    });
    showToast('Image pulled successfully!', 'success');
    statusBox.textContent = res;
    await fetchImages();
    await fetchSystemInfo();
    setTimeout(() => {
      closeModal('modal-pull-image');
      statusBox.classList.add('hidden');
      document.getElementById('form-pull-image').reset();
    }, 1200);
  } catch (err) {
    statusBox.textContent = `Error: ${err.message}`;
    showToast(`Pull failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pull';
  }
}

async function removeImage(id) {
  if (!confirm('Are you sure you want to delete this image?')) return;
  try {
    const msg = await apiCall(`/api/images/${id}?force=true`, { method: 'DELETE' });
    showToast(msg || 'Image deleted', 'success');
    await fetchImages();
    await fetchSystemInfo();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

// Volume & Network Modals
async function handleCreateVolume(e) {
  e.preventDefault();
  const name = document.getElementById('vol-name').value.trim();
  const driver = document.getElementById('vol-driver').value.trim() || undefined;

  try {
    await apiCall('/api/volumes/create', {
      method: 'POST',
      body: JSON.stringify({ name, driver })
    });
    showToast(`Volume "${name}" created!`, 'success');
    closeModal('modal-create-volume');
    document.getElementById('form-create-volume').reset();
    await fetchVolumes();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function removeVolume(name) {
  if (!confirm(`Remove volume "${name}"?`)) return;
  try {
    const msg = await apiCall(`/api/volumes/${name}`, { method: 'DELETE' });
    showToast(msg || 'Volume deleted', 'success');
    await fetchVolumes();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function handleCreateNetwork(e) {
  e.preventDefault();
  const name = document.getElementById('net-name').value.trim();
  const driver = document.getElementById('net-driver').value;

  try {
    await apiCall('/api/networks/create', {
      method: 'POST',
      body: JSON.stringify({ name, driver })
    });
    showToast(`Network "${name}" created!`, 'success');
    closeModal('modal-create-network');
    document.getElementById('form-create-network').reset();
    await fetchNetworks();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function removeNetwork(id, name) {
  if (!confirm(`Remove network "${name}"?`)) return;
  try {
    const msg = await apiCall(`/api/networks/${id}`, { method: 'DELETE' });
    showToast(msg || 'Network removed', 'success');
    await fetchNetworks();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// System Prune
async function triggerSystemPrune() {
  if (!confirm('Run System Prune?\nThis will remove stopped containers, unused networks, and dangling images.')) return;
  try {
    showToast('Pruning Docker resources...', 'info');
    const res = await apiCall('/api/system/prune', { method: 'POST' });
    const freed = formatBytes(res.space_reclaimed_bytes);
    showToast(`Prune completed! Freed ${freed}`, 'success');
    await loadAllData();
  } catch (err) {
    showToast(`Prune error: ${err.message}`, 'error');
  }
}

// Logs Modal
function openLogs(id, name) {
  activeLogsContainerId = id;
  document.getElementById('logs-modal-title').textContent = `Logs: ${name}`;
  document.getElementById('logs-content').textContent = 'Loading logs...';
  openModal('modal-logs');
  fetchCurrentLogs();
}

async function fetchCurrentLogs() {
  if (!activeLogsContainerId) return;
  const tail = document.getElementById('logs-tail-select').value;
  try {
    const logs = await apiCall(`/api/containers/${activeLogsContainerId}/logs?tail=${tail}`);
    const pre = document.getElementById('logs-content');
    pre.textContent = logs || '(No logs available)';
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    document.getElementById('logs-content').textContent = `Failed to fetch logs: ${err.message}`;
  }
}

function copyLogsToClipboard() {
  const text = document.getElementById('logs-content').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Logs copied to clipboard', 'info');
  });
}

// Inspect Modal
async function inspectContainer(id) {
  try {
    document.getElementById('inspect-modal-title').textContent = `Container Inspection (${id.substring(0, 12)})`;
    document.getElementById('inspect-content').textContent = 'Loading inspection details...';
    openModal('modal-inspect');

    const details = await apiCall(`/api/containers/${id}`);
    document.getElementById('inspect-content').textContent = JSON.stringify(details, null, 2);
  } catch (err) {
    document.getElementById('inspect-content').textContent = `Inspect failed: ${err.message}`;
  }
}

// Stats Modal
function openStats(id, name) {
  activeStatsContainerId = id;
  document.getElementById('stats-modal-title').textContent = `Live Stats: ${name}`;
  openModal('modal-stats');
  fetchCurrentStats();

  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(fetchCurrentStats, 2000);
}

async function fetchCurrentStats() {
  if (!activeStatsContainerId) return;
  try {
    const stats = await apiCall(`/api/containers/${activeStatsContainerId}/stats`);
    // CPU
    const cpuPct = Math.min(stats.cpu_percentage, 100);
    document.getElementById('stat-cpu-val').textContent = `${stats.cpu_percentage.toFixed(2)}%`;
    document.getElementById('stat-cpu-bar').style.width = `${cpuPct}%`;

    // Memory
    const memPct = Math.min(stats.memory_percentage, 100);
    document.getElementById('stat-mem-val').textContent = `${formatBytes(stats.memory_used)} / ${formatBytes(stats.memory_limit)} (${stats.memory_percentage.toFixed(1)}%)`;
    document.getElementById('stat-mem-bar').style.width = `${memPct}%`;

    // Net
    document.getElementById('stat-net-val').textContent = `RX: ${formatBytes(stats.network_rx_bytes)} | TX: ${formatBytes(stats.network_tx_bytes)}`;
  } catch (err) {
    console.error('Stats fetch error:', err);
  }
}

// Modal management
function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('show');
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('show');

  if (modalId === 'modal-stats' && statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
    activeStatsContainerId = null;
  }
  if (modalId === 'modal-logs') {
    activeLogsContainerId = null;
  }
}

// Click outside modal to close
window.onclick = function(event) {
  if (event.target.classList.contains('modal-backdrop')) {
    event.target.classList.remove('show');
    if (event.target.id === 'modal-stats' && statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  }
};

// Utilities
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimestamp(epochSec) {
  if (!epochSec) return '-';
  const date = new Date(epochSec * 1000);
  return date.toLocaleString();
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
