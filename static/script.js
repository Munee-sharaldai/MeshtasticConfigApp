// /opt/meshtastic-manager/static/script.js
const API_BASE = '/api';

document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM загружен');
    
    fetchDevices();
    refreshLogs();
    toggleConnectionFields();
    updateHealthStatus();
    
    // Обработчики форм
    const addForm = document.getElementById('addDeviceForm');
    if (addForm) {
        addForm.addEventListener('submit', handleAddDevice);
    }
    
    const configForm = document.getElementById('configForm');
    if (configForm) {
        configForm.addEventListener('submit', handleConfigSubmit);
    }
    
    // Индикатор статуса Range Test
    const rangeTestCheckbox = document.getElementById('rangeTestEnabled');
    if (rangeTestCheckbox) {
        rangeTestCheckbox.addEventListener('change', (e) => {
            updateRangeTestIndicator(e.target.checked);
        });
    }
    
    setInterval(updateHealthStatus, 30000);
});

// ============================================================================
// Устройства
// ============================================================================

async function fetchDevices() {
    try {
        const res = await fetch(`${API_BASE}/devices`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const devices = await res.json();
        renderDevices(devices);
    } catch (e) {
        console.error('❌ Ошибка загрузки устройств:', e);
        document.getElementById('devicesList').innerHTML = 
            '<div class="error-message">❌ Ошибка загрузки</div>';
    }
}

function renderDevices(devices) {
    const container = document.getElementById('devicesList');
    
    if (!devices?.length) {
        container.innerHTML = `
            <div class="no-devices"></div>
            <div class="no-devices">Нет устройств</div>
        `;
        return;
    }
    
    container.innerHTML = devices.map(d => {
        const identifier = d.connection_type === 'wifi' ? d.ip : d.serial_port;
        const badge = d.connection_type === 'wifi' ? '📶 WiFi' : '🔌 Serial';
        
        return `
        <div class="device-card ${d.connection_type}">
            <div class="device-header">
                <strong>${escapeHtml(d.name)}</strong>
                <span class="badge">${badge}</span>
            </div>
            <div class="device-info">
                ${d.connection_type === 'wifi' ? `IP: ${escapeHtml(d.ip)}` : `Порт: ${escapeHtml(d.serial_port)}`}<br>
                ID устройства: ${escapeHtml(d.node_id)}<br>
                Описание устройства: ${d.description ? `${escapeHtml(d.description)}` : ''}
            </div>
            <div class="device-actions">
                <button class="btn-small" onclick="checkStatus('${escapeHtml(identifier)}')">Статус</button>
                <button class="btn-small" onclick="selectConfig('${escapeHtml(identifier)}')">Параметры</button>
                <button class="btn-small" onclick="exportLog('${escapeHtml(identifier)}')">Лог</button>
            </div>
            <div class="device-actions">
                <button class="btn-small" onclick="reboot('${escapeHtml(identifier)}')">Перезагрузить</button>
                <button class="btn-small" onclick="deleteDevice('${escapeHtml(identifier)}')">Удалить</button>
            </div>
        </div>`;
    }).join('');
}

// ============================================================================
// Добавление устройства
// ============================================================================

function toggleConnectionFields() {
    const type = document.getElementById('devConnectionType')?.value;
    if (!type) return;
    
    const ipField = document.getElementById('devIp');
    const serialField = document.getElementById('devSerialPort');
    const refreshPortsButton = document.getElementById('refreshPortsButton');
    
    if (type === 'wifi') {
        ipField.hidden = false;
        ipField.required = true;
        serialField.hidden = true;
        serialField.required = false;
        serialField.value = '';
        refreshPortsButton.hidden = true;
    } else {
        ipField.hidden = true;
        ipField.required = false;
        ipField.value = '';
        serialField.hidden = false;
        serialField.required = true;
        refreshPortsButton.hidden = false;
        refreshSerialPorts();
    }
}

async function refreshSerialPorts() {
    try {
        const res = await fetch(`${API_BASE}/serial/ports`);
        const ports = await res.json();
        const select = document.getElementById('devSerialPort');
        select.innerHTML = '<option value="">Выберите порт</option>' + 
            ports.map(p => `<option value="${escapeHtml(p.port)}">${escapeHtml(p.port)}</option>`).join('');
    } catch (e) {
        console.error('❌ Ошибка получения портов:', e);
    }
}

async function handleAddDevice(e) {
    e.preventDefault();
    
    const connectionType = document.getElementById('devConnectionType').value;
    const data = {
        name: document.getElementById('devName').value.trim(),
        connection_type: connectionType,
        ip: connectionType === 'wifi' ? document.getElementById('devIp').value.trim() : null,
        serial_port: connectionType === 'serial' ? document.getElementById('devSerialPort').value : null,
        node_id: document.getElementById('devNodeId').value.trim(),
        description: document.getElementById('devDescription')?.value?.trim() || ''
    };
    
    if (!data.name || !data.node_id) {
        alert('❌ Заполните название и Node ID');
        return;
    }
    if (connectionType === 'wifi' && !data.ip) {
        alert('❌ Укажите IP для WiFi');
        return;
    }
    if (connectionType === 'serial' && !data.serial_port) {
        alert('❌ Выберите COM-порт');
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/devices`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        const result = await res.json();
        
        if (res.ok) {
            alert('✅ ' + result.message);
            document.getElementById('addDeviceForm').reset();
            fetchDevices();
            toggleConnectionFields();
        } else {
            alert('❌ ' + (result.detail || 'Ошибка'));
        }
    } catch (e) {
        alert('❌ Ошибка: ' + e.message);
    }
}

// ============================================================================
// Конфигурация: только Range Test
// ============================================================================

async function loadDeviceConfig(identifier) {
    console.log('📥 Загрузка config для:', identifier);
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/status`);
        const data = await res.json();
        console.log(data);
        // Значение по умолчанию
        let rangeTestEnabled = false;
        
        // Извлекаем из ответа (структура зависит от типа подключения)
        if (data.success && data.data) {
            // WiFi: module_config.range_test.enabled
            if (data.data.module_config?.range_test?.enabled !== undefined) {
                rangeTestEnabled = data.data.module_config.range_test.enabled;
            }
            // Serial: может быть в других полях, проверяем
            else if (data.data.range_test_enabled !== undefined) {
                rangeTestEnabled = data.data.range_test_enabled;
            }
        }
        
        // Применяем к форме
        document.getElementById('rangeTestEnabled').checked = rangeTestEnabled;
        updateRangeTestIndicator(rangeTestEnabled);
        
        console.log('✅ Config загружен: range_test =', rangeTestEnabled);
    } catch (e) {
        console.error('❌ Ошибка загрузки конфига:', e);
        updateRangeTestIndicator(false);
    }
}

function updateRangeTestIndicator(isEnabled) {
    const el = document.getElementById('rangeTestStatus');
    if (el) {
        el.textContent = isEnabled ? '✓ Включено' : '✗ Выключено';
        el.className = `status-badge ${isEnabled ? 'status-on' : 'status-off'}`;
    }
}

async function selectConfig(identifier) {
    if (!identifier) {
        alert('❌ Выберите устройство');
        return;
    }
    
    document.getElementById('configIdentifier').value = identifier;
    await loadDeviceConfig(identifier);
    document.querySelector('#configForm').scrollIntoView({ behavior: 'smooth' });
}

async function handleConfigSubmit(e) {
    e.preventDefault();
    
    const identifier = document.getElementById('configIdentifier').value;
    if (!identifier) {
        alert('❌ Устройство не выбрано');
        return;
    }
    
    // Только одно поле
    const config = {
        range_test_enabled: document.getElementById('rangeTestEnabled').checked
    };
    
    console.log('📦 Отправка config:', config);
    
    const confirmMsg = `Применить настройку Range Test?\n\n` +
        `Устройство: ${identifier}\n` +
        `Состояние: ${config.range_test_enabled ? '🟢 ВКЛ' : '🔴 ВЫКЛ'}`;
    
    if (!confirm(confirmMsg)) return;
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/configure`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config)
        });
        const data = await res.json();
        
        if (data.success) {
            const msg = data.data?.message || 'Настройка применена';
            const cliInfo = data.data?.cli_output ? `\n\n📋 Вывод:\n${data.data.cli_output}` : '';
            
            alert(`✅ ${msg}${cliInfo}\n\n🔄 Устройство автоматически перезагружается.`);
            
            // Обновляем статус через 5-7 секунд (после авто-ребута)
            setTimeout(() => {
                loadDeviceConfig(identifier);
            }, 7000);
        } else {
            alert('❌ Ошибка: ' + (data.error || 'Неизвестная'));
        }
    } catch (e) {
        alert('❌ Ошибка: ' + e.message);
    }
}

// ============================================================================
// Перезагрузка / Удаление / Статус
// ============================================================================

async function reboot(identifier) {
    if (!identifier) return alert('❌ Не указано устройство');
    
    if (!confirm('⚠️ Перезагрузить устройство?')) return;
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/reboot`, { method: 'POST' });
        const data = await res.json();
        alert(data.success ? '✅ Перезагрузка отправлена' : '❌ ' + (data.error || 'Ошибка'));
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

async function deleteDevice(identifier) {
    if (!identifier) return alert('❌ Не указано устройство');
    if (!confirm('🗑️ Удалить устройство из списка?')) return;
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}`, { method: 'DELETE' });
        if (res.ok) {
            fetchDevices();
        } else {
            const err = await res.json();
            alert('❌ ' + (err.detail || 'Ошибка'));
        }
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

async function checkStatus(identifier) {
    if (!identifier) return alert('❌ Не указано устройство');
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/status`);
        const data = await res.json();
        alert(data.success ? '✅ Онлайн:\n' + JSON.stringify(data.data, null, 2) : '❌ ' + (data.error || 'Ошибка'));
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

// ============================================================================
// Сообщения
// ============================================================================

async function sendMessage(identifier) {
    if (!identifier) return alert('❌ Не указано устройство');
    
    const nodeId = prompt('Node ID получателя (!xxxx):');
    if (!nodeId) return;
    const message = prompt('Текст:');
    if (!message) return;
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/message`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ node_id: nodeId, message })
        });
        const data = await res.json();
        alert(data.success ? '✅ Отправлено' : '❌ ' + (data.error || 'Ошибка'));
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

// ============================================================================
// Логи
// ============================================================================

async function refreshLogs() {
    try {
        const res = await fetch(`${API_BASE}/logs`);
        const logs = await res.json();
        const container = document.getElementById('logsList');
        
        if (!logs?.length) {
            container.innerHTML = '<div class="no-logs">Нет логов</div>';
            return;
        }
        
        container.innerHTML = logs.map(l => `
            <div class="log-item">
                <span>📄 ${escapeHtml(l.filename)}</span>
                <span class="log-size">${formatFileSize(l.size)}</span>
                <a href="${API_BASE}/logs/${encodeURIComponent(l.filename)}" download class="btn-small">📥</a>
            </div>
        `).join('');
    } catch (e) {
        console.error('❌ Ошибка логов:', e);
    }
}

async function exportLog(identifier) {
    if (!identifier) return alert('❌ Не указано устройство');
    
    try {
        const res = await fetch(`${API_BASE}/logs/export/${encodeURIComponent(identifier)}`, { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            alert('✅ Сохранён: ' + data.filename);
            refreshLogs();
        } else {
            alert('❌ ' + (data.detail || 'Ошибка'));
        }
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

async function exportAllLogs() {
    try {
        const res = await fetch(`${API_BASE}/devices`);
        const devices = await res.json();
        if (!devices?.length) return alert('⚠️ Нет устройств');
        
        let ok = 0, err = 0;
        for (const d of devices) {
            const id = d.connection_type === 'wifi' ? d.ip : d.serial_port;
            try {
                const r = await fetch(`${API_BASE}/logs/export/${encodeURIComponent(id)}`, { method: 'POST' });
                const data = await r.json();
                if (data.status === 'success') ok++; else err++;
            } catch { err++; }
            await new Promise(r => setTimeout(r, 500));
        }
        alert(`✅ Готово: ${ok} успешно, ${err} ошибок`);
        refreshLogs();
    } catch (e) {
        alert('❌ ' + e.message);
    }
}

// ============================================================================
// Статус сервера / Утилиты
// ============================================================================

async function updateHealthStatus() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        const el = document.getElementById('status');
        el.className = 'status-indicator status-ok';
        el.innerText = '● Онлайн';
        el.title = `Обновлено: ${data.timestamp}`;
    } catch {
        const el = document.getElementById('status');
        el.className = 'status-indicator status-error';
        el.innerText = '● Ошибка';
        el.title = 'Сервер недоступен';
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}