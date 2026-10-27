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

// Table sorting and pagination states
const tableStates = {
  dashboard: { sortKey: '', sortDir: 'asc', page: 1, pageSize: 5 },
  containers: { sortKey: '', sortDir: 'asc', page: 1, pageSize: 10 },
  images: { sortKey: '', sortDir: 'asc', page: 1, pageSize: 10 },
  volumes: { sortKey: '', sortDir: 'asc', page: 1, pageSize: 10 },
  networks: { sortKey: '', sortDir: 'asc', page: 1, pageSize: 10 },
};

// Terminal State
let activeTerminalContainerId = null;
let activeTerminalContainerName = '';
let terminalHistory = [];
let terminalHistoryIndex = -1;
let isTerminalRunning = false;

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
      tableStates.containers.page = 1;
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
  toggleSidebar(false);
}

function toggleSidebar(forceState) {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  const isOpen = typeof forceState === 'boolean' ? forceState : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', isOpen);
  if (backdrop) backdrop.classList.toggle('show', isOpen);
}

function setupEventListeners() {
  document.getElementById('btn-manual-refresh').addEventListener('click', () => {
    loadAllData();
    showToast('Refreshed data', 'info');
  });

  document.getElementById('auto-refresh-select').addEventListener('change', setupAutoRefresh);

  // Search input listeners (reset page to 1)
  document.getElementById('containers-search').addEventListener('input', () => {
    tableStates.containers.page = 1;
    renderContainersTable();
  });
  document.getElementById('images-search').addEventListener('input', () => {
    tableStates.images.page = 1;
    renderImagesTable();
  });
  document.getElementById('volumes-search').addEventListener('input', () => {
    tableStates.volumes.page = 1;
    renderVolumesTable();
  });
  document.getElementById('networks-search').addEventListener('input', () => {
    tableStates.networks.page = 1;
    renderNetworksTable();
  });

  // Logout buttons
  document.querySelectorAll('.btn-logout-action').forEach(btn => {
    btn.addEventListener('click', handleLogout);
  });

  // Terminal history navigation
  const termInput = document.getElementById('terminal-input');
  if (termInput) {
    termInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (terminalHistory.length > 0 && terminalHistoryIndex > 0) {
          terminalHistoryIndex--;
          termInput.value = terminalHistory[terminalHistoryIndex];
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (terminalHistoryIndex < terminalHistory.length - 1) {
          terminalHistoryIndex++;
          termInput.value = terminalHistory[terminalHistoryIndex];
        } else {
          terminalHistoryIndex = terminalHistory.length;
          termInput.value = '';
        }
      }
    });
  }
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

// Table Sorting & Pagination Engine
function handleTableSort(tableName, key) {
  const state = tableStates[tableName];
  if (!state) return;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = 'asc';
  }
  state.page = 1;
  renderTableByName(tableName);
}

function updateSortIcons(tableName) {
  const state = tableStates[tableName];
  if (!state) return;
  document.querySelectorAll(`[id^="sort-${tableName}-"]`).forEach(icon => {
    const key = icon.id.replace(`sort-${tableName}-`, '');
    if (key === state.sortKey) {
      icon.textContent = state.sortDir === 'asc' ? '▲' : '▼';
      icon.classList.remove('sort-dim');
    } else {
      icon.textContent = '↕';
      icon.classList.add('sort-dim');
    }
  });
}

function paginateAndSort(list, state, extractor) {
  let sorted = [...list];
  if (state.sortKey && extractor) {
    sorted.sort((a, b) => {
      const valA = extractor(a, state.sortKey);
      const valB = extractor(b, state.sortKey);
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      let cmp = 0;
      if (typeof valA === 'number' && typeof valB === 'number') {
        cmp = valA - valB;
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      }
      return state.sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const totalItems = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;

  const startIndex = (state.page - 1) * state.pageSize;
  const paginated = sorted.slice(startIndex, startIndex + state.pageSize);

  return {
    items: paginated,
    totalItems,
    totalPages,
    currentPage: state.page,
    pageSize: state.pageSize,
    startIndex: totalItems === 0 ? 0 : startIndex + 1,
    endIndex: Math.min(startIndex + state.pageSize, totalItems)
  };
}

function renderPaginationControls(tableName, pagination) {
  const container = document.getElementById(`${tableName}-pagination`);
  if (!container) return;

  if (pagination.totalItems === 0) {
    container.innerHTML = '';
    return;
  }

  const { currentPage, totalPages, totalItems, startIndex, endIndex, pageSize } = pagination;
  const options = [5, 10, 25, 50];
  if (!options.includes(pageSize)) options.push(pageSize);
  options.sort((a, b) => a - b);

  const sizeSelectHtml = `
    <div class="pagination-size">
      <label>Show:</label>
      <select onchange="handlePageSizeChange('${tableName}', this.value)">
        ${options.map(sz => `<option value="${sz}" ${sz === pageSize ? 'selected' : ''}>${sz}</option>`).join('')}
      </select>
    </div>
  `;

  const infoHtml = `<div class="pagination-info">Showing ${startIndex}–${endIndex} of ${totalItems}</div>`;

  const prevDisabled = currentPage <= 1 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

  let pages = [];
  let startP = Math.max(1, currentPage - 2);
  let endP = Math.min(totalPages, startP + 4);
  if (endP - startP < 4) {
    startP = Math.max(1, endP - 4);
  }
  for (let p = startP; p <= endP; p++) {
    pages.push(`<button type="button" class="btn-page ${p === currentPage ? 'active' : ''}" onclick="handlePageChange('${tableName}', ${p})">${p}</button>`);
  }

  const navHtml = `
    <div class="pagination-nav">
      <button type="button" class="btn-page" ${prevDisabled} onclick="handlePageChange('${tableName}', ${currentPage - 1})">‹ Prev</button>
      ${pages.join('')}
      <button type="button" class="btn-page" ${nextDisabled} onclick="handlePageChange('${tableName}', ${currentPage + 1})">Next ›</button>
    </div>
  `;

  container.innerHTML = `
    <div class="pagination-left">
      ${sizeSelectHtml}
      ${infoHtml}
    </div>
    ${navHtml}
  `;
}

function handlePageChange(tableName, page) {
  const state = tableStates[tableName];
  if (!state) return;
  state.page = page;
  renderTableByName(tableName);
}

function handlePageSizeChange(tableName, size) {
  const state = tableStates[tableName];
  if (!state) return;
  state.pageSize = parseInt(size, 10);
  state.page = 1;
  renderTableByName(tableName);
}

function renderTableByName(tableName) {
  if (tableName === 'dashboard') renderDashboardContainers();
  else if (tableName === 'containers') renderContainersTable();
  else if (tableName === 'images') renderImagesTable();
  else if (tableName === 'volumes') renderVolumesTable();
  else if (tableName === 'networks') renderNetworksTable();
}

function containerExtractor(c, key) {
  switch (key) {
    case 'state': return (c.state || '').toLowerCase();
    case 'name': return (c.names && c.names[0] ? c.names[0] : c.short_id || '').toLowerCase();
    case 'image': return (c.image || '').toLowerCase();
    case 'status': return (c.status || '').toLowerCase();
    case 'ports': return (c.ports || []).join(', ').toLowerCase();
    case 'created': return c.created || 0;
    default: return '';
  }
}

function imageExtractor(img, key) {
  switch (key) {
    case 'tag': return (img.repo_tags && img.repo_tags.length ? img.repo_tags.join(', ') : '<none>').toLowerCase();
    case 'id': return (img.short_id || '').toLowerCase();
    case 'size': return img.size || 0;
    case 'created': return img.created || 0;
    default: return '';
  }
}

function volumeExtractor(v, key) {
  switch (key) {
    case 'name': return (v.name || '').toLowerCase();
    case 'driver': return (v.driver || '').toLowerCase();
    case 'scope': return (v.scope || '').toLowerCase();
    case 'mountpoint': return (v.mountpoint || '').toLowerCase();
    default: return '';
  }
}

function networkExtractor(n, key) {
  switch (key) {
    case 'name': return (n.name || '').toLowerCase();
    case 'driver': return (n.driver || '').toLowerCase();
    case 'scope': return (n.scope || '').toLowerCase();
    case 'subnet': return (n.subnet || '').toLowerCase();
    case 'containers_count': return n.containers_count || 0;
    default: return '';
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
  updateSortIcons('dashboard');

  if (cachedContainers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">No containers found.</td></tr>`;
    const pagContainer = document.getElementById('dashboard-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const pagination = paginateAndSort(cachedContainers, tableStates.dashboard, containerExtractor);
  tbody.innerHTML = pagination.items.map(c => {
    const name = c.names[0] || c.short_id;
    const isRunning = c.state === 'running';
    return `
      <tr>
        <td><span class="status-pill status-${c.state.toLowerCase()}">${c.state}</span></td>
        <td><span class="cell-title" onclick="inspectContainer('${c.id}')">${escapeHtml(name)}</span></td>
        <td class="cell-sub">${escapeHtml(c.image)}</td>
        <td>${escapeHtml(c.status)}</td>
        <td class="cell-sub">${escapeHtml(c.ports.join(', ') || '-')}</td>
        <td>
          <div class="btn-action-group">
            ${isRunning 
              ? `<button class="btn-action" title="Stop" onclick="containerAction('${c.id}', 'stop')">⏹</button>`
              : `<button class="btn-action btn-action-success" title="Start" onclick="containerAction('${c.id}', 'start')">▶</button>`
            }
            <button class="btn-action" title="Logs" onclick="openLogs('${c.id}', '${escapeHtml(name)}')">📄</button>
            ${isRunning ? `<button class="btn-action btn-action-terminal" title="Terminal / Exec" onclick="openTerminal('${c.id}', '${escapeHtml(name)}')">💻</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderPaginationControls('dashboard', pagination);
}

function renderContainersTable() {
  const tbody = document.getElementById('containers-list');
  const search = (document.getElementById('containers-search').value || '').toLowerCase();
  updateSortIcons('containers');

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
    const pagContainer = document.getElementById('containers-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const pagination = paginateAndSort(filtered, tableStates.containers, containerExtractor);
  tbody.innerHTML = pagination.items.map(c => {
    const name = c.names[0] || c.short_id;
    const isRunning = c.state === 'running';
    const isPaused = c.state === 'paused';

    return `
      <tr>
        <td><span class="status-pill status-${c.state.toLowerCase()}">${c.state}</span></td>
        <td>
          <span class="cell-title" onclick="inspectContainer('${c.id}')">${escapeHtml(name)}</span>
          <div class="cell-sub">${escapeHtml(c.short_id)}</div>
        </td>
        <td class="cell-sub">${escapeHtml(c.image)}</td>
        <td>${escapeHtml(c.status)}</td>
        <td class="cell-sub">${escapeHtml(c.ports.join(', ') || '-')}</td>
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
            <button class="btn-action" title="Logs" onclick="openLogs('${c.id}', '${escapeHtml(name)}')">📄</button>
            ${isRunning ? `<button class="btn-action btn-action-terminal" title="Terminal / Exec" onclick="openTerminal('${c.id}', '${escapeHtml(name)}')">💻</button>` : ''}
            ${isRunning ? `<button class="btn-action" title="Stats" onclick="openStats('${c.id}', '${escapeHtml(name)}')">📊</button>` : ''}
            <button class="btn-action btn-action-danger" title="Remove" onclick="removeContainer('${c.id}', '${escapeHtml(name)}')">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderPaginationControls('containers', pagination);
}

function renderImagesTable() {
  const tbody = document.getElementById('images-list');
  const search = (document.getElementById('images-search').value || '').toLowerCase();
  updateSortIcons('images');

  let filtered = cachedImages.filter(img => {
    if (!search) return true;
    const matchTag = img.repo_tags.some(t => t.toLowerCase().includes(search));
    const matchId = img.short_id.toLowerCase().includes(search);
    return matchTag || matchId;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">No images found.</td></tr>`;
    const pagContainer = document.getElementById('images-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const pagination = paginateAndSort(filtered, tableStates.images, imageExtractor);
  tbody.innerHTML = pagination.items.map(img => {
    const tags = img.repo_tags.length ? img.repo_tags.join(', ') : '<none>';
    const primaryTag = img.repo_tags[0] || '';
    return `
      <tr>
        <td>
          <div class="cell-title">${escapeHtml(tags)}</div>
        </td>
        <td class="cell-sub">${escapeHtml(img.short_id)}</td>
        <td>${formatBytes(img.size)}</td>
        <td class="cell-sub">${formatTimestamp(img.created)}</td>
        <td class="text-right">
          <div class="btn-action-group">
            ${primaryTag && primaryTag !== '<none>' ? `
              <button class="btn-action btn-action-success" title="Deploy" onclick="deployFromImage('${escapeHtml(primaryTag)}')">▶ Run</button>
            ` : ''}
            <button class="btn-action btn-action-danger" title="Remove Image" onclick="removeImage('${img.id}')">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderPaginationControls('images', pagination);
}

function renderVolumesTable() {
  const tbody = document.getElementById('volumes-list');
  const search = (document.getElementById('volumes-search').value || '').toLowerCase();
  updateSortIcons('volumes');

  let filtered = cachedVolumes.filter(v => {
    if (!search) return true;
    return v.name.toLowerCase().includes(search) || v.driver.toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">No volumes found.</td></tr>`;
    const pagContainer = document.getElementById('volumes-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const pagination = paginateAndSort(filtered, tableStates.volumes, volumeExtractor);
  tbody.innerHTML = pagination.items.map(v => `
    <tr>
      <td><span class="cell-title">${escapeHtml(v.name)}</span></td>
      <td><span class="tag tag-gray">${escapeHtml(v.driver)}</span></td>
      <td>${escapeHtml(v.scope)}</td>
      <td class="cell-sub">${escapeHtml(v.mountpoint)}</td>
      <td class="text-right">
        <button class="btn-action btn-action-danger" title="Remove Volume" onclick="removeVolume('${escapeHtml(v.name)}')">🗑</button>
      </td>
    </tr>
  `).join('');

  renderPaginationControls('volumes', pagination);
}

function renderNetworksTable() {
  const tbody = document.getElementById('networks-list');
  const search = (document.getElementById('networks-search').value || '').toLowerCase();
  updateSortIcons('networks');

  let filtered = cachedNetworks.filter(n => {
    if (!search) return true;
    return n.name.toLowerCase().includes(search) || n.driver.toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">No networks found.</td></tr>`;
    const pagContainer = document.getElementById('networks-pagination');
    if (pagContainer) pagContainer.innerHTML = '';
    return;
  }

  const pagination = paginateAndSort(filtered, tableStates.networks, networkExtractor);
  tbody.innerHTML = pagination.items.map(n => `
    <tr>
      <td><span class="cell-title">${escapeHtml(n.name)}</span></td>
      <td><span class="tag tag-gray">${escapeHtml(n.driver)}</span></td>
      <td>${escapeHtml(n.scope)}</td>
      <td class="cell-sub">${n.subnet ? `${escapeHtml(n.subnet)} (${escapeHtml(n.gateway || 'no gw')})` : '-'}</td>
      <td>${n.containers_count} connected</td>
      <td class="text-right">
        ${!['bridge', 'host', 'none'].includes(n.name) ? `
          <button class="btn-action btn-action-danger" title="Remove Network" onclick="removeNetwork('${n.id}', '${escapeHtml(n.name)}')">🗑</button>
        ` : '<span class="cell-sub">system</span>'}
      </td>
    </tr>
  `).join('');

  renderPaginationControls('networks', pagination);
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

// Terminal / Exec Modal
function openTerminal(id, name) {
  activeTerminalContainerId = id;
  activeTerminalContainerName = name;
  document.getElementById('terminal-modal-title').textContent = `Terminal: ${name}`;
  const shortName = name.replace(/^\//, '');
  document.getElementById('terminal-prompt').textContent = `root@${shortName}:/#`;
  openModal('modal-terminal');

  const screen = document.getElementById('terminal-screen');
  screen.innerHTML = `
    <div class="terminal-line terminal-system">Connected to container ${escapeHtml(name)} (${id.substring(0, 12)})</div>
    <div class="terminal-line terminal-system">Shell: ${escapeHtml(getSelectedShell())} &bull; Type command or use Quick buttons below.</div>
  `;
  setTimeout(() => {
    const input = document.getElementById('terminal-input');
    if (input) input.focus();
  }, 100);
}

function handleShellChange() {
  const select = document.getElementById('terminal-shell-select');
  const customInput = document.getElementById('terminal-custom-shell');
  if (select.value === 'custom') {
    customInput.classList.remove('hidden');
    customInput.focus();
  } else {
    customInput.classList.add('hidden');
  }
}

function getSelectedShell() {
  const select = document.getElementById('terminal-shell-select');
  if (select.value === 'custom') {
    const customVal = (document.getElementById('terminal-custom-shell').value || '').trim();
    return customVal || '/bin/sh';
  }
  return select.value;
}

function clearTerminal() {
  const screen = document.getElementById('terminal-screen');
  screen.innerHTML = '<div class="terminal-line terminal-system">Terminal cleared.</div>';
  const input = document.getElementById('terminal-input');
  if (input) input.focus();
}

function runQuickCommand(cmd) {
  const input = document.getElementById('terminal-input');
  if (input) {
    input.value = cmd;
    executeTerminalCommand(cmd);
  }
}

function handleTerminalSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  executeTerminalCommand(cmd);
}

async function executeTerminalCommand(cmd) {
  if (!activeTerminalContainerId || isTerminalRunning) return;

  const screen = document.getElementById('terminal-screen');
  const input = document.getElementById('terminal-input');
  const btn = document.getElementById('btn-terminal-run');
  const shell = getSelectedShell();
  const promptText = document.getElementById('terminal-prompt').textContent;

  // Add to local history
  terminalHistory.push(cmd);
  terminalHistoryIndex = terminalHistory.length;

  // Render command line
  const cmdLine = document.createElement('div');
  cmdLine.className = 'terminal-line terminal-cmd';
  cmdLine.innerHTML = `<span class="term-prompt">${escapeHtml(promptText)}</span> <span class="term-command">${escapeHtml(cmd)}</span>`;
  screen.appendChild(cmdLine);

  input.value = '';
  input.disabled = true;
  btn.disabled = true;
  isTerminalRunning = true;

  const loadingLine = document.createElement('div');
  loadingLine.className = 'terminal-line terminal-loading';
  loadingLine.textContent = 'Running command...';
  screen.appendChild(loadingLine);
  screen.scrollTop = screen.scrollHeight;

  try {
    const res = await apiCall(`/api/containers/${activeTerminalContainerId}/exec`, {
      method: 'POST',
      body: JSON.stringify({
        shell: shell,
        command: cmd
      })
    });

    loadingLine.remove();

    const outLine = document.createElement('div');
    outLine.className = 'terminal-line terminal-output';
    outLine.textContent = res.output !== undefined && res.output !== '' ? res.output : '(No output)';
    screen.appendChild(outLine);

    if (res.exit_code !== undefined && res.exit_code !== null && res.exit_code !== 0) {
      const codeLine = document.createElement('div');
      codeLine.className = 'terminal-line terminal-error';
      codeLine.textContent = `[Process exited with code ${res.exit_code}]`;
      screen.appendChild(codeLine);
    }
  } catch (err) {
    loadingLine.remove();
    const errLine = document.createElement('div');
    errLine.className = 'terminal-line terminal-error';
    errLine.textContent = `Error: ${err.message}`;
    screen.appendChild(errLine);
  } finally {
    input.disabled = false;
    btn.disabled = false;
    isTerminalRunning = false;
    screen.scrollTop = screen.scrollHeight;
    input.focus();
  }
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
  if (el) {
    el.classList.add('show');
    document.body.classList.add('modal-open');
  }
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('show');

  if (!document.querySelector('.modal-backdrop.show')) {
    document.body.classList.remove('modal-open');
  }

  if (modalId === 'modal-stats' && statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
    activeStatsContainerId = null;
  }
  if (modalId === 'modal-logs') {
    activeLogsContainerId = null;
  }
  if (modalId === 'modal-terminal') {
    activeTerminalContainerId = null;
    activeTerminalContainerName = '';
    isTerminalRunning = false;
  }
}

// Click outside modal or press Escape to close
window.onclick = function(event) {
  if (event.target.classList.contains('modal-backdrop')) {
    closeModal(event.target.id);
  }
};

window.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    const openModals = document.querySelectorAll('.modal-backdrop.show');
    openModals.forEach(modal => closeModal(modal.id));
    toggleSidebar(false);
  }
});

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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
