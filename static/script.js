// /opt/meshtastic-manager/static/script.js

const API_BASE = '/api';

// ============================================================================
// Инициализация при загрузке страницы
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOM загружен, инициализация...');
    
    fetchDevices();
    refreshLogs();
    toggleConnectionFields();
    updateHealthStatus();
    
    // Привязка обработчика формы добавления устройства
    const addForm = document.getElementById('addDeviceForm');
    if (addForm) {
        console.log('✅ Форма добавления найдена');
        addForm.addEventListener('submit', handleAddDevice);
    } else {
        console.error('❌ Форма addDeviceForm не найдена!');
    }
    
    // Привязка обработчика формы конфигурации
    const configForm = document.getElementById('configForm');
    if (configForm) {
        console.log('✅ Форма конфигурации найдена');
        configForm.addEventListener('submit', handleConfigSubmit);
    } else {
        console.error('❌ Форма configForm не найдена!');
    }
    
    // Обработчик чекбокса Range Test
    const rangeTestCheckbox = document.getElementById('rangeTestEnabled');
    if (rangeTestCheckbox) {
        rangeTestCheckbox.addEventListener('change', (e) => {
            updateRangeTestIndicator(e.target.checked);
        });
    }
    
    // Автообновление статуса
    setInterval(updateHealthStatus, 30000);
});

// ============================================================================
// Работа с устройствами
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
            '<div class="error-message">❌ Ошибка загрузки устройств</div>';
    }
}

function renderDevices(devices) {
    const container = document.getElementById('devicesList');
    
    if (!devices || devices.length === 0) {
        container.innerHTML = '<div class="no-devices">Нет добавленных устройств</div>';
        return;
    }
    
    container.innerHTML = devices.map(d => {
        const identifier = d.connection_type === 'wifi' ? d.ip : d.serial_port;
        const connectionBadge = d.connection_type === 'wifi' ? '📶 WiFi' : '🔌 Serial';
        const connectionClass = d.connection_type === 'wifi' ? 'wifi' : 'serial';
        
        return `
        <div class="device-card ${connectionClass}">
            <div class="device-header">
                <strong>${escapeHtml(d.name)}</strong>
                <span class="badge">${connectionBadge}</span>
            </div>
            <div class="device-info">
                ${d.connection_type === 'wifi' ? `IP: ${escapeHtml(d.ip)}` : `Порт: ${escapeHtml(d.serial_port)}`}<br>
                Node: ${escapeHtml(d.node_id)}
                ${d.description ? `<br>📝 ${escapeHtml(d.description)}` : ''}
            </div>
            <div class="device-actions">
                <button class="btn-small" onclick="checkStatus('${escapeHtml(identifier)}')">Статус</button>
                <button class="btn-small" onclick="selectConfig('${escapeHtml(identifier)}')">Настроить</button>
                <button class="btn-small" onclick="exportLog('${escapeHtml(identifier)}')">Лог</button>
                <button class="btn-small" onclick="sendMessage('${escapeHtml(identifier)}')">SMS</button>
                <button class="btn-small btn-warning" onclick="reboot('${escapeHtml(identifier)}')">Reboot</button>
                <button class="btn-small btn-danger" onclick="deleteDevice('${escapeHtml(identifier)}')">Удалить</button>
            </div>
        </div>
    `}).join('');
}

// ============================================================================
// Добавление устройства
// ============================================================================

function toggleConnectionFields() {
    const type = document.getElementById('devConnectionType')?.value;
    if (!type) return;
    
    const ipField = document.getElementById('devIp');
    const serialField = document.getElementById('devSerialPort');
    
    if (type === 'wifi') {
        ipField.disabled = false;
        ipField.required = true;
        ipField.placeholder = 'IP адрес (192.168.x.x)';
        serialField.disabled = true;
        serialField.required = false;
        serialField.value = '';
    } else {
        ipField.disabled = true;
        ipField.required = false;
        ipField.value = '';
        ipField.placeholder = '';
        serialField.disabled = false;
        serialField.required = true;
        refreshSerialPorts();
    }
}

async function refreshSerialPorts() {
    try {
        const res = await fetch(`${API_BASE}/serial/ports`);
        const ports = await res.json();
        const select = document.getElementById('devSerialPort');
        select.innerHTML = '<option value="">Выберите порт</option>' + 
            ports.map(p => `<option value="${escapeHtml(p.port)}">${escapeHtml(p.port)} - ${escapeHtml(p.description)}</option>`).join('');
    } catch (e) {
        console.error('❌ Ошибка получения портов:', e);
    }
}

async function handleAddDevice(e) {
    e.preventDefault();
    console.log('📝 Отправка формы добавления устройства...');
    
    const connectionType = document.getElementById('devConnectionType').value;
    const data = {
        name: document.getElementById('devName').value.trim(),
        connection_type: connectionType,
        ip: connectionType === 'wifi' ? document.getElementById('devIp').value.trim() : null,
        serial_port: connectionType === 'serial' ? document.getElementById('devSerialPort').value : null,
        node_id: document.getElementById('devNodeId').value.trim(),
        description: document.getElementById('devDescription')?.value?.trim() || ''
    };
    
    // Валидация
    if (!data.name || !data.node_id) {
        alert('❌ Заполните название и Node ID');
        return;
    }
    
    if (connectionType === 'wifi' && !data.ip) {
        alert('❌ Укажите IP адрес для WiFi подключения');
        return;
    }
    
    if (connectionType === 'serial' && !data.serial_port) {
        alert('❌ Выберите COM-порт для Serial подключения');
        return;
    }
    
    console.log('📦 Отправляемые данные:', data);
    
    try {
        const res = await fetch(`${API_BASE}/devices`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
        
        const result = await res.json();
        console.log('📥 Ответ сервера:', result);
        
        if (res.ok) {
            alert('✅ Устройство добавлено: ' + result.message);
            document.getElementById('addDeviceForm').reset();
            fetchDevices();
            toggleConnectionFields();
        } else {
            alert('❌ Ошибка: ' + (result.detail || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

// ============================================================================
// Конфигурация устройства (ПОЛНАЯ ЛОГИКА)
// ============================================================================

async function loadDeviceConfig(identifier) {
    console.log('📥 Загрузка конфигурации для:', identifier);
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/status`);
        const data = await res.json();
        
        // Значения по умолчанию
        let posInterval = 300;
        let gpsInterval = 30;
        let powerWaitSecs = 60;
        let txPower = 20;
        let modemPreset = 'LONG_MODERATE';
        let rangeTestEnabled = false;
        
        if (data.success && data.data) {
            console.log('📊 Получены данные:', data.data);
            
            // Позиция
            if (data.data.position) {
                posInterval = data.data.position.position_broadcast_secs || posInterval;
                gpsInterval = data.data.position.gps_update_interval || gpsInterval;
            }
            // Питание
            if (data.data.power) {
                powerWaitSecs = data.data.power.wait_bluetooth_secs || powerWaitSecs;
            }
            // LoRa
            if (data.data.lora) {
                txPower = data.data.lora.tx_power || txPower;
                modemPreset = data.data.lora.modem_preset || modemPreset;
            }
            // Range Test
            if (data.data.module_config?.range_test?.enabled !== undefined) {
                rangeTestEnabled = data.data.module_config.range_test.enabled;
            }
        }
        
        // Заполняем форму
        document.getElementById('posInterval').value = posInterval;
        document.getElementById('gpsInterval').value = gpsInterval;
        document.getElementById('powerWaitSecs').value = powerWaitSecs;
        document.getElementById('txPower').value = txPower;
        document.getElementById('modemPreset').value = modemPreset;
        document.getElementById('rangeTestEnabled').checked = rangeTestEnabled;
        
        // Обновляем визуальный индикатор
        updateRangeTestIndicator(rangeTestEnabled);
        
        console.log('✅ Конфигурация загружена');
        
    } catch (e) {
        console.error('❌ Ошибка загрузки конфига:', e);
        // При ошибке используем значения по умолчанию
        updateRangeTestIndicator(false);
    }
}

function updateRangeTestIndicator(isEnabled) {
    const statusEl = document.getElementById('rangeTestStatus');
    if (statusEl) {
        statusEl.textContent = isEnabled ? 'true' : 'false';
        statusEl.className = `status-badge ${isEnabled ? 'status-on' : 'status-off'}`;
    }
}

async function selectConfig(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    console.log('⚙️ Выбор устройства для настройки:', identifier);
    document.getElementById('configIdentifier').value = identifier;
    
    // Загружаем текущие настройки перед показом формы
    await loadDeviceConfig(identifier);
    
    // Прокрутка к форме
    document.querySelector('#configForm').scrollIntoView({ behavior: 'smooth' });
}

async function handleConfigSubmit(e) {
    e.preventDefault();
    console.log('📝 Отправка конфигурации...');
    
    const identifier = document.getElementById('configIdentifier').value;
    if (!identifier) {
        alert('❌ Выберите устройство');
        return;
    }
    
    // Собираем данные из формы
    const config = {
        position_broadcast_secs: parseInt(document.getElementById('posInterval').value) || 300,
        gps_update_interval: parseInt(document.getElementById('gpsInterval').value) || 30,
        power_wait_bluetooth_secs: parseInt(document.getElementById('powerWaitSecs').value) || 60,
        lora_tx_power: parseInt(document.getElementById('txPower').value) || 20,
        lora_modem_preset: document.getElementById('modemPreset').value,
        range_test_enabled: document.getElementById('rangeTestEnabled').checked
    };
    
    console.log('📦 Отправляемая конфигурация:', config);
    
    // Подтверждение
    const confirmMsg = `Применить настройки для устройства?\n\n` +
        `📍 Позиция: ${config.position_broadcast_secs} сек\n` +
        `📡 LoRa: ${config.lora_modem_preset} (${config.lora_tx_power} dBm)\n` +
        `🧪 Range Test: ${config.range_test_enabled ? 'ВКЛ' : 'ВЫКЛ'}`;
    
    if (!confirm(confirmMsg)) {
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/configure`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config)
        });
        
        const data = await res.json();
        console.log('📥 Ответ сервера:', data);
        
        if (data.success) {
            const rebootConfirm = confirm('✅ Настройки применены!\n\nПерезагрузить устройство сейчас?');
            if (rebootConfirm) {
                await reboot(identifier);
            }
        } else {
            alert('❌ Ошибка: ' + (data.error || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

// ============================================================================
// Перезагрузка устройства
// ============================================================================

async function reboot(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    console.log('🔄 Перезагрузка устройства:', identifier);
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/reboot`, {
            method: 'POST'
        });
        
        const data = await res.json();
        
        if (data.success) {
            alert('✅ Команда перезагрузки отправлена');
        } else {
            alert('❌ Ошибка: ' + (data.error || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

// ============================================================================
// Удаление устройства
// ============================================================================

async function deleteDevice(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    if (!confirm('⚠️ Удалить устройство из списка?\n\nЭто не сбросит настройки самого устройства.')) {
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            fetchDevices();
        } else {
            const err = await res.json();
            alert('❌ Ошибка: ' + (err.detail || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

// ============================================================================
// Проверка статуса
// ============================================================================

async function checkStatus(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    console.log('🔍 Проверка статуса:', identifier);
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/status`);
        const data = await res.json();
        
        if (data.success) {
            let info = '✅ Устройство онлайн!\n\n';
            if (data.data) {
                info += JSON.stringify(data.data, null, 2);
            }
            alert(info);
        } else {
            alert('❌ Ошибка: ' + (data.error || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

// ============================================================================
// Отправка сообщений
// ============================================================================

async function sendMessage(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    const nodeId = prompt('Node ID получателя (например, !55c8278c):');
    if (!nodeId) return;
    
    const message = prompt('Текст сообщения:');
    if (!message) return;
    
    console.log('💬 Отправка сообщения:', { to: nodeId, message });
    
    try {
        const res = await fetch(`${API_BASE}/devices/${encodeURIComponent(identifier)}/message`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                node_id: nodeId,
                message: message
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            alert('✅ Сообщение отправлено');
        } else {
            alert('❌ Ошибка: ' + (data.error || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
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
        
        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="no-logs">Нет сохранённых логов</div>';
            return;
        }
        
        container.innerHTML = logs.map(l => `
            <div class="log-item">
                <span>📄 ${escapeHtml(l.filename)}</span>
                <span class="log-size">${formatFileSize(l.size)}</span>
                <a href="${API_BASE}/logs/${encodeURIComponent(l.filename)}" download class="btn-small">📥 Скачать</a>
            </div>
        `).join('');
    } catch (e) {
        console.error('❌ Ошибка загрузки логов:', e);
    }
}

async function exportLog(identifier) {
    if (!identifier) {
        alert('❌ Не указано устройство');
        return;
    }
    
    console.log('📤 Экспорт лога:', identifier);
    
    try {
        const res = await fetch(`${API_BASE}/logs/export/${encodeURIComponent(identifier)}`, {
            method: 'POST'
        });
        
        const data = await res.json();
        
        if (data.status === 'success') {
            alert(`✅ Лог сохранён: ${data.filename}`);
            refreshLogs();
        } else {
            alert('❌ Ошибка экспорта: ' + (data.detail || 'Неизвестная ошибка'));
        }
    } catch (e) {
        console.error('❌ Ошибка fetch:', e);
        alert('❌ Ошибка соединения: ' + e.message);
    }
}

async function exportAllLogs() {
    try {
        const res = await fetch(`${API_BASE}/devices`);
        const devices = await res.json();
        
        if (!devices || devices.length === 0) {
            alert('⚠️ Нет устройств для экспорта');
            return;
        }
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const d of devices) {
            const identifier = d.connection_type === 'wifi' ? d.ip : d.serial_port;
            try {
                const res = await fetch(`${API_BASE}/logs/export/${encodeURIComponent(identifier)}`, {
                    method: 'POST'
                });
                const data = await res.json();
                if (data.status === 'success') {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (e) {
                errorCount++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        
        alert(`✅ Экспорт завершён\nУспешно: ${successCount}\nОшибок: ${errorCount}`);
        refreshLogs();
    } catch (e) {
        console.error('❌ Ошибка:', e);
        alert('❌ Ошибка: ' + e.message);
    }
}

// ============================================================================
// Статус сервера
// ============================================================================

async function updateHealthStatus() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        
        const statusEl = document.getElementById('status');
        statusEl.className = 'status-indicator status-ok';
        statusEl.innerText = '● Онлайн';
        statusEl.title = `Сервер: ${data.timestamp}`;
    } catch (e) {
        const statusEl = document.getElementById('status');
        statusEl.className = 'status-indicator status-error';
        statusEl.innerText = '● Ошибка';
        statusEl.title = 'Сервер недоступен';
    }
}

// ============================================================================
// Утилиты
// ============================================================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}