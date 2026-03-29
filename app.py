from fastapi import FastAPI, HTTPException, BackgroundTasks
from dotenv import load_dotenv
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import requests
import json
import os
import logging
from datetime import datetime
from typing import Optional, Literal
import uvicorn
import serial
import serial.tools.list_ports
import subprocess
import shlex
import re
import nmap
import asyncio
from collections import defaultdict
from datetime import datetime

try:
    from meshtastic.serial_interface import SerialInterface
    MESHTASTIC_LIB_AVAILABLE = True
except ImportError as e:
    MESHTASTIC_LIB_AVAILABLE = False
    print(f"⚠️ Библиотека meshtastic не установлена: {e}")

app = FastAPI(title="Meshtastic Manager - CLI Mode")
app.mount("/static", StaticFiles(directory="static"), name="static")

# Настройки
load_dotenv()
LOGS_DIR = "logs"
DEVICES_FILE = "devices.json"
os.makedirs(LOGS_DIR, exist_ok=True)

active_log_sessions: dict[str, dict] = {}
LOG_BUFFER_SIZE = 1000  # Макс. количество строк в буфере на устройство

if (str(os.getenv("NMAP_PATH")) not in os.environ["PATH"]):
    os.environ["PATH"] += (";"+str(os.getenv("NMAP_PATH")))

# Логирование
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Модели данных ---
class DeviceConfig(BaseModel):
    range_test_enabled: bool = False
    wifi_enabled: bool = False

class DeviceParam(BaseModel):
    param_name: Literal["range_test_enabled", "wifi_enabled", "wifi_ssid", "wifi_psk", "modem_preset", "role", "position_broadcast_secs", "gps_update_interval", "sender"]
    bool_param: Optional[bool] = None
    str_param: Optional[str] = None
    int_param: Optional[int] = None
    float_param: Optional[float] = None

class DeviceFromFrontend(BaseModel):
    connection_type: Literal["wifi", "serial"] = "wifi"
    ip: Optional[str] = None
    serial_port: Optional[str] = None

class DeviceInBackend(DeviceFromFrontend):
    name: str
    node_id: int
    config: DeviceConfig

class MessageRequest(BaseModel):
    node_id: str
    message: str

# --- Хелперы ---
def scan_with_nmap(network='192.168.0.0/24'):
    nm = nmap.PortScanner()
    nm.scan(hosts=network, arguments='-sn')  # Ping scan
    devices = []
    for host in nm.all_hosts():
        if 'mac' in nm[host]['addresses']:
            devices.append({
                'ip': host,
                'mac': nm[host]['addresses']['mac'],
                'vendor': nm[host]['vendor'].get(nm[host]['addresses']['mac'], 'Unknown')
            })
    return devices

def parse_meshtastic_info(output: str) -> dict:
    """
    Парсит вывод команды с возможными многострочными JSON-значениями.
    """
    result = {}
    lines = output.strip().split('\n')
    i = 0
    
    while i < len(lines):
        line = lines[i].strip()
        
        # Пропускаем пустые строки
        if not line:
            i += 1
            continue
        
        # Проверяем, является ли строка началом новой секции
        # Секция начинается с имени (без отступов) и содержит ': '
        match = re.match(r'^([A-Za-z0-9_ ]+)\s*:\s*(.*)$', line)
        
        if match:
            key = match.group(1)
            value_start = match.group(2).strip()
            
            # Если значение пустое или начинается с { или [, собираем многострочное значение
            if value_start.startswith('{') or value_start.startswith('['):
                # Собираем все строки до закрытия скобок
                json_lines = [value_start]
                bracket_count = value_start.count('{') - value_start.count('}')
                bracket_count += value_start.count('[') - value_start.count(']')
                
                i += 1
                while i < len(lines) and bracket_count > 0:
                    current_line = lines[i]
                    json_lines.append(current_line)
                    bracket_count += current_line.count('{') - current_line.count('}')
                    bracket_count += current_line.count('[') - current_line.count(']')
                    i += 1
                
                # Объединяем и парсим JSON
                json_string = '\n'.join(json_lines)
                try:
                    parsed_value = json.loads(json_string)
                except json.JSONDecodeError as e:
                    # Если невалидный JSON, оставляем как строку
                    parsed_value = json_string
                    print(f"Warning: Invalid JSON for key '{key}': {e}")
                
                result[key] = parsed_value
            else:
                # Однострочное значение
                try:
                    parsed_value = json.loads(value_start)
                except json.JSONDecodeError:
                    parsed_value = value_start
                result[key] = parsed_value
                i += 1
        else:
            # Строка не является началом секции, пропускаем
            i += 1
    
    return json.loads(json.dumps(result, indent=2, ensure_ascii=False))

def load_devices():
    if not os.path.exists(DEVICES_FILE):
        return []
    try:
        with open(DEVICES_FILE, 'r', encoding='utf-8') as f:
            content = f.read().strip()
            if not content:
                return []
            return json.loads(content)
    except (json.JSONDecodeError, Exception) as e:
        logger.error(f"Ошибка загрузки {DEVICES_FILE}: {e}")
        return []

def save_devices(devices):
    temp_file = f"{DEVICES_FILE}.tmp"
    try:
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(devices, f, indent=2, ensure_ascii=False)
        os.replace(temp_file, DEVICES_FILE)
    except Exception as e:
        logger.error(f"Ошибка сохранения {DEVICES_FILE}: {e}")
        if os.path.exists(temp_file):
            os.remove(temp_file)
        raise

def get_available_serial_ports():
    ports = serial.tools.list_ports.comports()
    return [{"port": p.device, "description": p.description, "hwid": p.hwid} for p in ports]

def get_available_wifi_ips():
    subnet = subprocess.run(
        ["arp", "-a"],
        capture_output=True,
        universal_newlines=True,
        shell=False,
        timeout=10,
        encoding="cp866"
    ).stdout.strip().split('\n')[0].split(' ')[1]
    while (subnet[-1] != '.'):
        subnet = subnet[:-1]
    subnet+='0/24'
    devices = scan_with_nmap(subnet)
    
    return [{'ip': device['ip']} for device in devices if device['vendor'] == 'Espressif']

def send_device_request(ip, endpoint, method="GET", timeout=10):
    """Запрос к устройству через WiFi HTTP API (только для чтения)"""
    url = f"http://{ip}{endpoint}"
    try:
        if method == "GET":
            resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        return {"success": True, "data": resp.json() if resp.text else {}}
    except requests.exceptions.RequestException as e:
        logger.error(f"Ошибка подключения к {ip}: {e}")
        return {"success": False, "error": str(e)}

def get_serial_interface(port):
    if not MESHTASTIC_LIB_AVAILABLE:
        return None
    try:
        interface = SerialInterface(port)
        return interface
    except Exception as e:
        logger.error(f"Ошибка подключения к порту {port}: {e}")
        return None

def run_meshtastic_cli(args: list, timeout: int = 30) -> dict:
    """
    Запускает команду meshtastic CLI и возвращает результат.
    
    Args:
        args: список аргументов без 'meshtastic' в начале
        timeout: таймаут выполнения в секундах
    
    Returns:
        dict с полями: success, output, error
    """
    try:
        # Проверяем наличие CLI
        result = subprocess.run(
            ["meshtastic", "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            return {
                "success": False,
                "error": "CLI meshtastic не установлен или не в PATH. Установите: pip install meshtastic"
            }
        
        # Формируем полную команду
        cmd = ["meshtastic"] + args
        logger.debug(f"🔧 Выполняю команду: {' '.join(shlex.quote(a) for a in cmd)}")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        
        if 'Connected to radio' in result.stdout:
            return {
                "success": True,
                "output": result.stdout.strip(),
                "error": None
            }
        else:
            error_msg = result.stderr.strip() or result.stdout.strip() or "Неизвестная ошибка"
            logger.error(f"❌ CLI ошибка: {error_msg}")
            return {
                "success": False,
                "error": error_msg,
                "output": result.stdout.strip()
            }
            
    except subprocess.TimeoutExpired:
        logger.error(f"⏱️ Таймаут выполнения команды: {' '.join(args)}")
        return {"success": False, "error": "Таймаут выполнения команды"}
    except FileNotFoundError:
        return {"success": False, "error": "Команда 'meshtastic' не найдена. Установите: pip install meshtastic"}
    except Exception as e:
        logger.error(f"❌ Неожиданная ошибка CLI: {e}")
        return {"success": False, "error": str(e)}
    
async def start_meshtastic_listen(identifier: str, connect_args: list[str]):
    """Запускает meshtastic --listen в фоне и накапливает логи"""
    cmd = ["meshtastic"] + connect_args + ["--listen"]
    logger.info(f"🎧 Запуск прослушивания для {identifier}: {' '.join(cmd)}")
    
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL
        )
        
        active_log_sessions[identifier] = {
            "process": process,
            "logs": [],
            "started_at": datetime.now(),
            "status": "running"
        }
        
        # Читаем stdout в фоне
        while process.returncode is None and active_log_sessions.get(identifier, {}).get("status") == "running":
            line = await process.stdout.readline()
            if not line:
                break
            decoded = line.decode('utf-8', errors='replace').strip()
            if decoded:
                # Добавляем метку времени
                log_entry = f"[{datetime.now().isoformat()}] {decoded}"
                # Добавляем в буфер с ограничением размера
                buffer = active_log_sessions[identifier]["logs"]
                buffer.append(log_entry)
                if len(buffer) > LOG_BUFFER_SIZE:
                    buffer.pop(0)  # Удаляем старые записи
        
        # Процесс завершился
        if identifier in active_log_sessions:
            active_log_sessions[identifier]["status"] = "stopped"
            await process.wait()
            
    except Exception as e:
        logger.error(f"❌ Ошибка в listen-сессии {identifier}: {e}")
        if identifier in active_log_sessions:
            active_log_sessions[identifier]["status"] = "error"

# --- API Эндпоинты ---

@app.get("/")
async def root():
    return FileResponse('static/index.html')

@app.get("/api/devices")
async def get_devices():
    return load_devices()

@app.post("/api/devices")
async def add_device(device: DeviceFromFrontend):
    devices = load_devices()
    connect_args = []

    if device.connection_type == "wifi":
        connect_args = ["--host", device.ip]
        if not device.ip:
            raise HTTPException(status_code=400, detail="Для WiFi подключения необходим IP-адрес")
        if any(d.get('ip') == device.ip for d in devices):
            raise HTTPException(status_code=400, detail="Устройство с таким IP уже существует")
    elif device.connection_type == "serial":
        connect_args = ["--port", device.serial_port]
        if not device.serial_port:
            raise HTTPException(status_code=400, detail="Для Serial подключения необходим COM-порт")
        if any(d.get('serial_port') == device.serial_port for d in devices):
            raise HTTPException(status_code=400, detail="Устройство с таким портом уже существует")
    
    # Запрос информации: --info без загрузки узлов для скорости
    result = run_meshtastic_cli(connect_args + ["--info", "--no-nodes"], timeout=30)
    parsedData = parse_meshtastic_info(result.get("output", ""))
    name = parsedData['Owner']
    node_id = parsedData['My info']['myNodeNum']
    config = DeviceConfig(range_test_enabled=parsedData['Module preferences']['rangeTest']['enabled'])
    deviceInBackend = DeviceInBackend(name=name, connection_type=device.connection_type, serial_port=device.serial_port, ip=device.ip, node_id=node_id, config=config)
    devices.append(deviceInBackend.model_dump())
    save_devices(devices)
    logger.info(f"Добавлено устройство: {name} ({device.connection_type})")
    return {"status": "success", "message": f"Устройство {name} добавлено"}

@app.delete("/api/devices/{identifier}")
async def delete_device(identifier: str):
    devices = load_devices()
    devices = [d for d in devices if d.get('ip') != identifier and d.get('serial_port') != identifier]
    save_devices(devices)
    return {"status": "success", "message": f"Устройство {identifier} удалено"}

@app.get("/api/devices/{identifier}/status")
async def get_device_status(identifier: str):
    """Проверка доступности устройства через CLI с парсингом вывода"""
    devices = load_devices()
    device = next((d for d in devices if d['ip'] == identifier or d['serial_port'] == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    # Аргументы подключения
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    # Запрос информации: --info без загрузки узлов для скорости
    result = run_meshtastic_cli(connect_args + ["--info", "--no-nodes"], timeout=30)
    
    output = result.get("output", "")
    parsed = parse_meshtastic_info(output)
    
    if parsed:  
        logger.info(f"✅ Статус получен: {parsed['My info']['myNodeNum']} FW:{parsed['Metadata']['firmwareVersion']}")
        return {
            "success": True, 
            "data": parsed,
        }
    else:
        logger.error(f"❌ Ошибка статуса {identifier}: {result.get('error')}")
        return {"success": False, "error": result.get("error", "Неизвестная ошибка")}

@app.post("/api/devices/{identifier}/configure")
async def configure_device(identifier: str, param: DeviceParam):
    """Отправка настройки range_test через CLI
        device:
            device.button_gpio
            device.buzzer_gpio
            device.debug_log_enabled
            device.disable_triple_click
            device.double_tap_as_button_press
            device.is_managed
            device.led_heartbeat_disabled
            device.node_info_broadcast_secs
            device.rebroadcast_mode
            device.role
            device.serial_enabled
            device.tzdef
        position:
            position.broadcast_smart_minimum_distance
            position.broadcast_smart_minimum_interval_secs
            position.fixed_position
            position.gps_attempt_time
            position.gps_en_gpio
            position.gps_enabled
            position.gps_mode
            position.gps_update_interval
            position.position_broadcast_secs
            position.position_broadcast_smart_enabled
            position.position_flags
            position.rx_gpio
            position.tx_gpio
        power:
            power.adc_multiplier_override
            power.device_battery_ina_address
            power.is_power_saving
            power.ls_secs
            power.min_wake_secs
            power.on_battery_shutdown_after_secs
            power.powermon_enables
            power.sds_secs
            power.wait_bluetooth_secs
        network:
            network.address_mode
            network.eth_enabled
            network.ipv4_config
            network.ntp_server
            network.rsyslog_server
            network.wifi_enabled
            network.wifi_psk
            network.wifi_ssid
        display:
            display.auto_screen_carousel_secs
            display.compass_north_top
            display.compass_orientation
            display.displaymode
            display.flip_screen
            display.gps_format
            display.heading_bold
            display.oled
            display.screen_on_secs
            display.units
            display.wake_on_tap_or_motion
        lora:
            lora.bandwidth
            lora.channel_num
            lora.coding_rate
            lora.frequency_offset
            lora.hop_limit
            lora.ignore_incoming
            lora.ignore_mqtt
            lora.modem_preset
            lora.override_duty_cycle
            lora.override_frequency
            lora.pa_fan_disabled
            lora.region
            lora.spread_factor
            lora.sx126x_rx_boosted_gain
            lora.tx_enabled
            lora.tx_power
            lora.use_preset
        bluetooth:
            bluetooth.device_logging_enabled
            bluetooth.enabled
            bluetooth.fixed_pin
            bluetooth.mode
        mqtt:
            mqtt.address
            mqtt.enabled
            mqtt.encryption_enabled
            mqtt.json_enabled
            mqtt.map_report_settings
            mqtt.map_reporting_enabled
            mqtt.password
            mqtt.proxy_to_client_enabled
            mqtt.root
            mqtt.tls_enabled
            mqtt.username
        serial:
            serial.baud
            serial.echo
            serial.enabled
            serial.mode
            serial.override_console_serial_port
            serial.rxd
            serial.timeout
            serial.txd
        external_notification:
            external_notification.active
            external_notification.alert_bell
            external_notification.alert_bell_buzzer
            external_notification.alert_bell_vibra
            external_notification.alert_message
            external_notification.alert_message_buzzer
            external_notification.alert_message_vibra
            external_notification.enabled
            external_notification.nag_timeout
            external_notification.output
            external_notification.output_buzzer
            external_notification.output_ms
            external_notification.output_vibra
            external_notification.use_i2s_as_buzzer
            external_notification.use_pwm
        store_forward:
            store_forward.enabled
            store_forward.heartbeat
            store_forward.history_return_max
            store_forward.history_return_window
            store_forward.is_server
            store_forward.records
        range_test:
            range_test.enabled
            range_test.save
            range_test.sender
        telemetry:
            telemetry.air_quality_enabled
            telemetry.air_quality_interval
            telemetry.device_update_interval
            telemetry.environment_display_fahrenheit
            telemetry.environment_measurement_enabled
            telemetry.environment_screen_enabled
            telemetry.environment_update_interval
            telemetry.power_measurement_enabled
            telemetry.power_screen_enabled
            telemetry.power_update_interval
        canned_message:
            canned_message.allow_input_source
            canned_message.enabled
            canned_message.inputbroker_event_ccw
            canned_message.inputbroker_event_cw
            canned_message.inputbroker_event_press
            canned_message.inputbroker_pin_a
            canned_message.inputbroker_pin_b
            canned_message.inputbroker_pin_press
            canned_message.rotary1_enabled
            canned_message.send_bell
            canned_message.updown1_enabled
        audio:
            audio.bitrate
            audio.codec2_enabled
            audio.i2s_din
            audio.i2s_sck
            audio.i2s_sd
            audio.i2s_ws
            audio.ptt_pin
        remote_hardware:
            remote_hardware.allow_undefined_pin_access
            remote_hardware.available_pins
            remote_hardware.enabled
        neighbor_info:
            neighbor_info.enabled
            neighbor_info.update_interval
        ambient_lighting:
            ambient_lighting.blue
            ambient_lighting.current
            ambient_lighting.green
            ambient_lighting.led_state
            ambient_lighting.red
        detection_sensor:
            detection_sensor.detection_triggered_high
            detection_sensor.enabled
            detection_sensor.minimum_broadcast_secs
            detection_sensor.monitor_pin
            detection_sensor.name
            detection_sensor.send_bell
            detection_sensor.state_broadcast_secs
            detection_sensor.use_pullup
        paxcounter:
            paxcounter.ble_threshold
            paxcounter.enabled
            paxcounter.paxcounter_update_interval
            paxcounter.wifi_threshold
    """
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    # Аргументы подключения
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    result = []
    if param.param_name == 'range_test_enabled':
        result = run_meshtastic_cli(connect_args + ['--set', 'range_test.enabled', 'true' if param.bool_param else 'false'], timeout=45)
    elif param.param_name == 'wifi_enabled':
        result = run_meshtastic_cli(connect_args + ['--set', 'network.wifi_enabled', 'true' if param.bool_param else 'false'], timeout=45)
    elif param.param_name == 'wifi_ssid':
        result = run_meshtastic_cli(connect_args + ['--set', 'network.wifi_ssid', param.str_param], timeout=45)
    elif param.param_name == 'wifi_psk':
        result = run_meshtastic_cli(connect_args + ['--set', 'network.wifi_psk', param.str_param], timeout=45)
    elif param.param_name == 'modem_preset':
        result = run_meshtastic_cli(connect_args + ['--set', 'lora.modem_preset', param.str_param], timeout=45)
    elif param.param_name == 'role':
        result = run_meshtastic_cli(connect_args + ['--set', 'device.role', param.str_param], timeout=45)
    elif param.param_name == 'position_broadcast_secs':
        result = run_meshtastic_cli(connect_args + ['--set', 'position.position_broadcast_secs', str(param.int_param)], timeout=45)
    elif param.param_name == 'gps_broadcast_interval':
        result = run_meshtastic_cli(connect_args + ['--set', 'position.gps_update_interval', str(param.int_param)], timeout=45)
    else:
        result = run_meshtastic_cli(connect_args + ['--set', 'range_test.sender', str(param.int_param)], timeout=45)

    if result["success"]:
        logger.info(f"✅ Параметр {param.param_name} применен на {identifier}")
        return {
            "success": True, 
            "data": {
                "message": "Параметры обновлены"
            }
        }
    else:
        logger.error(f"❌ Ошибка настройки параметра {param.param_name} на {identifier}: {result.get('error')}")
        return {
            "success": False, 
            "data": {
                "message": f"Параметры не обновлены из-за ошибки: {result.get('error')}", 
            }
        }

@app.post("/api/devices/{identifier}/reboot")
async def reboot_device(identifier: str):
    """Перезагрузка устройства через CLI"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    result = run_meshtastic_cli(connect_args + ["--reboot"], timeout=20)
    
    if result["success"]:
        return {"success": True, "data": {"message": "Перезагрузка отправлена"}}
    else:
        return {"success": False, "error": result.get("error", "Неизвестная ошибка")}

@app.post("/api/devices/{identifier}/message")
async def send_message(identifier: str, req: MessageRequest):
    """Отправка сообщения через CLI"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    # 🔧 Команда отправки: --sendtext "текст" --dest !xxxx
    send_args = ["--sendtext", req.message, "--dest", req.node_id]
    
    result = run_meshtastic_cli(connect_args + send_args, timeout=30)
    
    if result["success"]:
        return {"success": True, "data": {"message": "Сообщение отправлено"}}
    else:
        return {"success": False, "error": result.get("error", "Неизвестная ошибка")}

@app.get("/api/serial/ports")
async def list_serial_ports():
    return get_available_serial_ports()

@app.get("/api/logs")
async def logs():
    return {'filename': 'log.txt', 'size': '1000'}

@app.get("/api/wifi/ips")
async def list_wifi_ips():
    return get_available_wifi_ips()

# После существующих эндпоинтов добавьте:

@app.post("/api/logs/{identifier}/start")
async def start_logging(identifier: str):
    """Запускает запись логов для устройства"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    # Если уже запущено — перезапускаем
    if identifier in active_log_sessions and active_log_sessions[identifier]["status"] == "running":
        await stop_logging_internal(identifier)
    
    # Аргументы подключения
    connect_args = ["--host", device['ip']] if device['connection_type'] == 'wifi' else ["--port", device['serial_port']]
    
    # Запускаем в фоне
    asyncio.create_task(start_meshtastic_listen(identifier, connect_args))
    
    return {"success": True, "message": f"Запись логов запущена для {identifier}"}


async def stop_logging_internal(identifier: str):
    """Внутренняя функция остановки записи"""
    if identifier not in active_log_sessions:
        return
    session = active_log_sessions[identifier]
    if session["status"] == "running" and session["process"]:
        session["status"] = "stopping"
        try:
            session["process"].terminate()
            await asyncio.wait_for(session["process"].wait(), timeout=5.0)
        except:
            session["process"].kill()  # Force kill if needed
        logger.info(f"⏹️ Остановлена запись логов для {identifier}")


@app.post("/api/logs/{identifier}/stop")
async def stop_logging(identifier: str):
    """Останавливает запись логов"""
    await stop_logging_internal(identifier)
    return {"success": True, "message": f"Запись логов остановлена для {identifier}"}


@app.get("/api/logs/{identifier}")
async def get_logs(identifier: str, lines: int = 100):
    """Возвращает последние логи устройства"""
    if identifier not in active_log_sessions:
        raise HTTPException(status_code=404, detail="Сессия логов не найдена")
    
    session = active_log_sessions[identifier]
    logs = session["logs"][-lines:] if lines > 0 else session["logs"]
    
    return {
        "success": True,
        "identifier": identifier,
        "started_at": session["started_at"].isoformat(),
        "status": session["status"],
        "line_count": len(session["logs"]),
        "logs": logs
    }


@app.get("/api/logs/{identifier}/download")
async def download_logs(identifier: str):
    """Скачивает логи как текстовый файл"""
    if identifier not in active_log_sessions:
        raise HTTPException(status_code=404, detail="Сессия логов не найдена")
    
    session = active_log_sessions[identifier]
    log_content = "\n".join(session["logs"])
    
    filename = f"meshtastic_logs_{identifier}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    
    # Создаём временный файл
    temp_path = os.path.join(LOGS_DIR, filename)
    with open(temp_path, "w", encoding="utf-8") as f:
        # Добавляем заголовок
        f.write(f"# Meshtastic Logs for {identifier}\n")
        f.write(f"# Started: {session['started_at'].isoformat()}\n")
        f.write(f"# Status: {session['status']}\n")
        f.write("# " + "="*70 + "\n\n")
        f.write(log_content)
    
    return FileResponse(
        temp_path,
        media_type="text/plain",
        filename=filename,
        background=BackgroundTasks().add_task(lambda p: os.remove(p) if os.path.exists(p) else None, temp_path)
    )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)