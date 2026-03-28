// /opt/meshtastic-manager/static/script.js
const API_BASE = '/api';

document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM загружен');
    
    fetchDevices();
    refreshLogs();
    toggleConnectionFields();
    
    // Обработчики форм
    const addForm = document.getElementById('addDeviceForm');
    if (addForm) {
        addForm.addEventListener('submit', handleAddDevice);
    }

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
    const refreshIPsButton = document.getElementById('refreshIPsButton');
    
    if (type === 'wifi') {
        ipField.hidden = false;
        ipField.required = true;
        serialField.hidden = true;
        serialField.required = false;
        serialField.value = '';
        refreshIPs();
        refreshIPsButton.hidden = false;
        refreshPortsButton.hidden = true;
    } else {
        ipField.hidden = true;
        ipField.required = false;
        ipField.value = '';
        serialField.hidden = false;
        serialField.required = true;
        refreshSerialPorts();
        refreshPortsButton.hidden = false;
        refreshIPsButton.hidden = true;
    }
}

async function refreshSerialPorts() {
    try {
        const select = document.getElementById('devSerialPort');
        select.disabled = true;
        select.innerHTML = '<option value="">Обновление портов...</option>';
        const res = await fetch(`${API_BASE}/serial/ports`);
        const ports = await res.json();
        select.innerHTML = '<option value="">Выберите порт</option>' + 
            ports.map(p => `<option value="${escapeHtml(p.port)}">${escapeHtml(p.port)}</option>`).join('');
        select.disabled = false;
    } catch (e) {
        console.error('❌ Ошибка получения портов:', e);
    }
}

async function refreshIPs() {
    try {
        const select = document.getElementById('devIp');
        select.disabled = true;
        select.innerHTML = '<option value="">Обновление IP...</option>';
        const res = await fetch(`${API_BASE}/wifi/ips`);
        const ips = await res.json();
        select.innerHTML = '<option value="">Выберите IP</option>' + 
            ips.map(p => `<option value="${escapeHtml(p.ip)}">${escapeHtml(p.ip)}</option>`).join('');
        select.disabled = false;
    } catch (e) {
        console.error('❌ Ошибка получения ip:', e);
    }
}

async function handleAddDevice(e) {
    e.preventDefault();
    
    const connectionType = document.getElementById('devConnectionType').value;
    const data = {
        connection_type: connectionType,
        ip: connectionType === 'wifi' ? document.getElementById('devIp').value.trim() : null,
        serial_port: connectionType === 'serial' ? document.getElementById('devSerialPort').value : null
    };
    
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
    section = document.getElementById('config-section');
    container = document.getElementById('config-forms-container');
    console.log('📥 Загрузка config для:', identifier);
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/status`);
        const data = await res.json();
        let rangeTestEnabled = false;
        
        // Извлекаем из ответа (структура зависит от типа подключения)
        if (data['success'] && data['data']) {
            // WiFi: module_config.range_test.enabled
            section.querySelector('h2').innerHTML = `Параметры устройства ${/\([A-z0-9 ]+\)/.exec(data['data']['Owner'])}`;
            if (data['data']['Module preferences']['rangeTest']['enabled'] !== undefined) {
                rangeTestEnabled = data['data']['Module preferences']['rangeTest']['enabled'];
                container.innerHTML = `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label" width="100%">
                            <span>Range test enabled</span>
                            <input name='range_test_enabled' type="checkbox" id="rangeTestEnabled" ${rangeTestEnabled ? 'checked' : ''}>
                        </label>
                        <div>
                            <button type="submit" width="100%">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Module preferences']['rangeTest']['sender'] !== undefined)) {
                sender = data['data']['Module preferences']['rangeTest']['sender'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Sender message interval (seconds)</span>
                            <input name='sender' type="number" id="sender" value="${sender}">
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['network']['wifiEnabled'] !== undefined)) {
                wifiEnabled = data['data']['Preferences']['network']['wifiEnabled'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Wi-Fi enabled</span>
                            <input name='wifi_enabled' type="checkbox" id="wifiEnabled" ${wifiEnabled ? 'checked' : ''}>
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['network']['wifiSsid'] !== undefined)) {
                wifiSsid = data['data']['Preferences']['network']['wifiSsid'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Wi-Fi SSID</span>
                            <input name='wifi_ssid' type="text" id="wifiSsid" value="${wifiSsid}">
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['network']['wifiPsk'] !== undefined)) {
                wifiPsk = data['data']['Preferences']['network']['wifiPsk'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Wi-Fi PSK</span>
                            <input name='wifi_psk' type="text" id="wifiPsk" value="${wifiPsk}">
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['lora']['modemPreset'] !== undefined)) {
                modemPreset = data['data']['Preferences']['lora']['modemPreset'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Настройка канала</span>
                            <select name='modem_preset' type="text" id="modemPreset" value="${modemPreset}">
                                <option value="SHORT_FAST" ${modemPreset == "SHORT_FAST" ? 'selected' : ''}>Малое расстояние / Быстро</option>
                                <option value="SHORT_SLOW" ${modemPreset == "SHORT_SLOW" ? 'selected' : ''}>Малое расстояние / Медленный</option>
                                <option value="MEDIUM_FAST" ${modemPreset == "MEDIUM_FAST" ? 'selected' : ''}>Среднее расстояние / Быстро</option>
                                <option value="MEDIUM_SLOW" ${modemPreset == "MEDIUM_SLOW" ? 'selected' : ''}>Среднее расстояние / Медленный</option>
                                <option value="LONG_FAST" ${modemPreset == "LONG_FAST" ? 'selected' : ''}>Большое расстояние / Быстро</option>
                                <option value="LONG_MODERATE" ${modemPreset == "LONG_MODERATE" ? 'selected' : ''}>Большая дальность / Умеренная</option>
                                <option value="LONG_SLOW" ${modemPreset == "LONG_SLOW" ? 'selected' : ''}>Дальний / Медленный</option>
                                <option value="VERY_LONG_SLOW" ${modemPreset == "VERY_LONG_SLOW " ? 'selected' : ''}>Очень большое расстояние / Медленный</option>
                            </select>
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['device']['role'] !== undefined)) {
                role = data['data']['Preferences']['device']['role'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Role</span>
                            <select name='role' type="text" id="role" value="${role}">
                                <option value="CLIENT" ${role == "CLIENT" ? 'selected' : ''}>CLIENT</option>
                                <option value="CLIENT_MUTE" ${role == "CLIENT_MUTE" ? 'selected' : ''}>CLIENT_MUTE</option>
                                <option value="ROUTER" ${role == "ROUTER" ? 'selected' : ''}>ROUTER</option>
                                <option value="ROUTER_CLIENT" ${role == "ROUTER_CLIENT" ? 'selected' : ''}>ROUTER_CLIENT</option>
                                <option value="REPEATER" ${role == "REPEATER" ? 'selected' : ''}>REPEATER</option>
                                <option value="TRACKER" ${role == "TRACKER" ? 'selected' : ''}>TRACKER</option>
                                <option value="SENSOR" ${role == "SENSOR" ? 'selected' : ''}>SENSOR</option>
                                <option value="TAK" ${role == "TAK " ? 'selected' : ''}>TAK</option>
                                <option value="CLIENT_HIDDEN" ${role == "CLIENT_HIDDEN " ? 'selected' : ''}>CLIENT_HIDDEN</option>
                                <option value="LOST_AND_FOUND" ${role == "LOST_AND_FOUND " ? 'selected' : ''}>LOST_AND_FOUND</option>
                                <option value="TAK_TRACKER" ${role == "TAK_TRACKER " ? 'selected' : ''}>TAK_TRACKER</option>
                            </select>
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['position']['positionBroadcastSecs'] !== undefined)) {
                positionBroadcastSecs = data['data']['Preferences']['position']['positionBroadcastSecs'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>Position broadcast interval (seconds)</span>
                            <input name='position_broadcast_secs' type="number" id="positionBroadcastSecs" value="${positionBroadcastSecs}">
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            if ((data['data']['Preferences']['position']['gpsUpdateInterval'] !== undefined)) {
                gpsUpdateInterval = data['data']['Preferences']['position']['gpsUpdateInterval'];
                container.innerHTML += `
                <form class="configForm">
                    <div class="form-row">
                        <label class="checkbox-label">
                            <span>GPS update interval (seconds)</span>
                            <input name='gps_update_interval' type="number" id="gpsUpdateInterval" value="${gpsUpdateInterval}">
                        </label>
                        <div>
                            <button type="submit">Применить</button>
                        </div>
                    </div>
                </form>
                `;
            }
            const configForms = document.getElementsByClassName('configForm');
            if (configForms) {
                for (let configForm of configForms) {
                    configForm.addEventListener('submit', handleConfigSubmit);
                }
            }
        } else {
            container.innerHTML = 'Ошибка получения параметров';
        }
        
        updateRangeTestIndicator(rangeTestEnabled);
        
        console.log('✅ Config загружен: ', data['data']);
    } catch (e) {
        console.error('❌ Ошибка загрузки конфига:', e);
        container.innerHTML = 'Ошибка получения параметров';
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
    container = document.getElementById('config-forms-container');
    container.innerHTML = `
    <form id="configForm">
        <input type="hidden" id="configIdentifier">
        <div class="form-row">
            Загрузка параметров...
        </div>
    </form>
    `;
    if (!identifier) {
        alert('❌ Выберите устройство');
        return;
    }
    document.getElementById('configIdentifier').value = identifier;
    await loadDeviceConfig(identifier);
    document.querySelector('#config-forms-container').scrollIntoView({ behavior: 'smooth' });
}

async function handleConfigSubmit(e) {
    e.preventDefault();
    let config = {};
    identifier = document.getElementById('configIdentifier').value;
    if (e.target.range_test_enabled) {
        config = {
            param_name: 'range_test_enabled',
            bool_param: e.target.range_test_enabled.checked
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Range test enabled: ${config.bool_param ? '🟢 ВКЛ' : '🔴 ВЫКЛ'}`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.sender) {
        config = {
            param_name: 'sender',
            int_param: e.target.sender.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Ranger test sender: ${config.int_param }`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.wifi_enabled) {
        config = {
            param_name: 'wifi_enabled',
            bool_param: e.target.wifi_enabled.checked
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Wi-Fi enabled: ${config.bool_param ? '🟢 ВКЛ' : '🔴 ВЫКЛ'}`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.wifi_ssid) {
        config = {
            param_name: 'wifi_ssid',
            str_param: e.target.wifi_ssid.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Wi-Fi SSID: ${config.str_param}`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.wifi_psk) {
        config = {
            param_name: 'wifi_psk',
            str_param: e.target.wifi_psk.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Wi-Fi PSK: ${config.str_param }`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.modem_preset) {
        config = {
            param_name: 'modem_preset',
            str_param: e.target.modem_preset.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `LoRa modem preset: ${config.str_param }`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.role) {
        config = {
            param_name: 'role',
            str_param: e.target.role.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Device role: ${config.str_param }`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.position_broadcast_secs) {
        config = {
            param_name: 'position_broadcast_secs',
            int_param: e.target.position_broadcast_secs.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Position broadcast secs: ${config.int_param }`;
        
        if (!confirm(confirmMsg)) return;
    } else if (e.target.gps_update_interval) {
        config = {
            param_name: 'gps_update_interval',
            int_param: e.target.gps_update_interval.value
        };
        console.log('📦 Отправка config:', config);
        
        const confirmMsg = `Применить параметры?\n\n` +
            `Устройство: ${identifier}\n` +
            `Posion gps update interval: ${config.int_param }`;
        
        if (!confirm(confirmMsg)) return;
    }
    
    try {
        container = document.getElementById('config-forms-container');
        container.innerHTML = `
        <form class="config-form">
            <div class="form-row">
                Обновление параметров...
            </div>
        </form>
        `;
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/configure`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config)
        });
        const data = await res.json();
        
        if (data.success) {
            const msg = data.data?.message || 'Параметры применены';
            
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
        container = document.getElementById('config-forms-container');
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