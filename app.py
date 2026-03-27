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

if (str(os.getenv("NMAP_PATH")) not in os.environ["PATH"]):
    os.environ["PATH"] += (";"+str(os.getenv("NMAP_PATH")))

# Логирование
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Модели данных ---
class DeviceConfig(BaseModel):
    range_test_enabled: bool = False

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
        
        if result.returncode == 0:
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
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    # Аргументы подключения
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    # Запрос информации: --info без загрузки узлов для скорости
    result = run_meshtastic_cli(connect_args + ["--info", "--no-nodes"], timeout=30)
    
    if result["success"]:
        output = result.get("output", "")
        parsed = parse_meshtastic_info(output)
        
        logger.info(f"✅ Статус получен: {parsed['My info']['myNodeNum']} FW:{parsed['Metadata']['firmwareVersion']}")
        return {
            "success": True, 
            "data": parsed,
        }
    else:
        logger.error(f"❌ Ошибка статуса {identifier}: {result.get('error')}")
        return {"success": False, "error": result.get("error", "Неизвестная ошибка")}

@app.post("/api/devices/{identifier}/configure")
async def configure_device(identifier: str, config: DeviceConfig):
    """Отправка настройки range_test через CLI"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    # Аргументы подключения
    if device['connection_type'] == 'wifi':
        connect_args = ["--host", device['ip']]
    else:
        connect_args = ["--port", device['serial_port']]
    
    # Формируем команду
    value_str = "true" if config.range_test_enabled else "false"
    set_args = ["--set", "range_test.enabled", value_str]
    
    logger.info(f"⚙️ Применяю: range_test.enabled={value_str} для {identifier}")
    
    result = run_meshtastic_cli(connect_args + set_args, timeout=45)
    
    if result["success"]:
        output = result.get("output", "").lower()
        
        # 🔧 Проверяем, что настройка действительно применилась
        # Успешный вывод содержит: "Writing modified preferences to device"
        if "writing modified preferences" in output or "setting range_test" in output:
            logger.info(f"✅ Настройка применена на {identifier}")
            return {
                "success": True, 
                "data": {
                    "message": "Range Test обновлён", 
                    "applied_value": config.range_test_enabled,
                    "cli_output": result.get("output", "")[:300]  # Короткий вывод
                }
            }
        else:
            # Команда выполнилась, но вывод подозрительный
            logger.warning(f"⚠️ Неоднозначный результат настройки {identifier}: {output[:200]}")
            return {
                "success": True,  # Считаем успешным, но с предупреждением
                "data": {
                    "message": "Команда отправлена (проверьте статус)",
                    "warning": "Вывод CLI не содержит явного подтверждения",
                    "cli_output": result.get("output", "")[:300]
                }
            }
    else:
        logger.error(f"❌ Ошибка настройки {identifier}: {result.get('error')}")
        return {"success": False, "error": result.get("error", "Неизвестная ошибка")}

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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)