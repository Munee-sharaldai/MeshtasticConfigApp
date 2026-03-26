# /opt/meshtastic-manager/app.py
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
import requests
import json
import os
import logging
from datetime import datetime
from typing import List, Optional, Literal
import uvicorn
import glob
import serial
import serial.tools.list_ports

# Meshtastic library для serial подключения
try:
    from meshtastic.serial_interface import SerialInterface
    from meshtastic.mesh_pb2 import DeviceConfig, PositionConfig, PowerConfig, LoRaConfig
    MESHTASTIC_LIB_AVAILABLE = True
except ImportError:
    MESHTASTIC_LIB_AVAILABLE = False
    print("⚠️ Библиотека meshtastic не установлена. Serial-подключение будет ограничено.")

app = FastAPI(title="Meshtastic Manager (WiFi + Serial)")
app.mount("/static", StaticFiles(directory="static"), name="static")

# Настройки
LOGS_DIR = "logs"
DEVICES_FILE = "devices.json"
os.makedirs(LOGS_DIR, exist_ok=True)

# Логирование
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Модели данных ---
class Device(BaseModel):
    name: str
    connection_type: Literal["wifi", "serial"] = "wifi"
    ip: Optional[str] = None
    serial_port: Optional[str] = None
    node_id: str
    description: Optional[str] = ""

class DeviceConfig(BaseModel):
    position_broadcast_secs: int = 300
    gps_update_interval: int = 30
    power_wait_bluetooth_secs: int = 60
    lora_tx_power: int = 20
    lora_modem_preset: str = "LONG_MODERATE"
    range_test_enabled: bool = False  # ← НОВОЕ ПОЛЕ

class MessageRequest(BaseModel):
    node_id: str
    message: str

# --- Хелперы ---
def load_devices():
    if os.path.exists(DEVICES_FILE):
        with open(DEVICES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_devices(devices):
    with open(DEVICES_FILE, 'w', encoding='utf-8') as f:
        json.dump(devices, f, indent=2, ensure_ascii=False)

def get_available_serial_ports():
    """Получить список доступных COM-портов"""
    ports = serial.tools.list_ports.comports()
    return [{"port": p.device, "description": p.description, "hwid": p.hwid} for p in ports]

def send_device_request(ip, endpoint, method="GET", json_data=None, timeout=10):
    """Запрос к устройству через WiFi HTTP API"""
    url = f"http://{ip}{endpoint}"
    try:
        if method == "GET":
            resp = requests.get(url, timeout=timeout)
        elif method == "POST":
            resp = requests.post(url, json=json_data, timeout=timeout)
        elif method == "PUT":
            resp = requests.put(url, json=json_data, timeout=timeout)
        resp.raise_for_status()
        return {"success": True, "data": resp.json() if resp.text else {}}
    except requests.exceptions.RequestException as e:
        logger.error(f"Ошибка подключения к {ip}: {e}")
        return {"success": False, "error": str(e)}

def get_serial_interface(port):
    """Создать интерфейс для serial подключения"""
    if not MESHTASTIC_LIB_AVAILABLE:
        return None
    try:
        interface = SerialInterface(port)
        return interface
    except Exception as e:
        logger.error(f"Ошибка подключения к порту {port}: {e}")
        return None

# --- API Эндпоинты ---

@app.get("/")
async def root():
    return FileResponse('static/index.html')

@app.get("/api/devices")
async def get_devices():
    return load_devices()

@app.post("/api/devices")
async def add_device(device: Device):
    devices = load_devices()
    
    # Валидация в зависимости от типа подключения
    if device.connection_type == "wifi":
        if not device.ip:
            raise HTTPException(status_code=400, detail="Для WiFi подключения необходим IP-адрес")
        if any(d.get('ip') == device.ip for d in devices):
            raise HTTPException(status_code=400, detail="Устройство с таким IP уже существует")
    elif device.connection_type == "serial":
        if not device.serial_port:
            raise HTTPException(status_code=400, detail="Для Serial подключения необходим COM-порт")
        if any(d.get('serial_port') == device.serial_port for d in devices):
            raise HTTPException(status_code=400, detail="Устройство с таким портом уже существует")
    
    devices.append(device.dict())
    save_devices(devices)
    logger.info(f"Добавлено устройство: {device.name} ({device.connection_type})")
    return {"status": "success", "message": f"Устройство {device.name} добавлено"}

@app.delete("/api/devices/{identifier}")
async def delete_device(identifier: str):
    """Удаление устройства по IP или serial_port"""
    devices = load_devices()
    devices = [d for d in devices if d.get('ip') != identifier and d.get('serial_port') != identifier]
    save_devices(devices)
    return {"status": "success", "message": f"Устройство {identifier} удалено"}

@app.get("/api/devices/{identifier}/status")
async def get_device_status(identifier: str):
    """Проверка доступности устройства (WiFi или Serial)"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    if device['connection_type'] == 'wifi':
        result = send_device_request(device['ip'], "/api/v1/info")
        if result["success"]:
            nodes_result = send_device_request(device['ip'], "/api/v1/nodes")
            result["nodes"] = nodes_result.get("data", {})
        return result
    
    elif device['connection_type'] == 'serial':
        if not MESHTASTIC_LIB_AVAILABLE:
            return {"success": False, "error": "Библиотека meshtastic не установлена"}
        
        try:
            interface = get_serial_interface(device['serial_port'])
            if interface:
                node = interface.localNode
                info = {
                    "node_id": node.getNodeNum(),
                    "hw_model": node.hwModel,
                    "firmware_version": node.firmwareVersion if hasattr(node, 'firmwareVersion') else "unknown"
                }
                interface.close()
                return {"success": True, "data": info}
            else:
                return {"success": False, "error": "Не удалось подключиться к порту"}
        except Exception as e:
            return {"success": False, "error": str(e)}

@app.post("/api/devices/{identifier}/configure")
async def configure_device(identifier: str, config: DeviceConfig):
    """Отправка настроек конфигурации"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    payload = {
        "position": {
            "position_broadcast_secs": config.position_broadcast_secs,
            "gps_update_interval": config.gps_update_interval
        },
        "power": {
            "wait_bluetooth_secs": config.power_wait_bluetooth_secs
        },
        "lora": {
            "tx_power": config.lora_tx_power,
            "modem_preset": config.lora_modem_preset
        },
        "module_config": {  # ← НОВОЕ: настройки модулей
            "range_test": {
                "enabled": config.range_test_enabled
            }
        }
    }
    
    if device['connection_type'] == 'wifi':
        result = send_device_request(device['ip'], "/api/v1/config", method="PUT", json_data=payload)
        if result["success"]:
            logger.info(f"Конфигурация обновлена на {device['ip']} (WiFi)")
        return result
    
    elif device['connection_type'] == 'serial':
        if not MESHTASTIC_LIB_AVAILABLE:
            return {"success": False, "error": "Библиотека meshtastic не установлена"}
        
        try:
            interface = get_serial_interface(device['serial_port'])
            if interface:
                node = interface.localNode
                
                # Отправка конфигурации через serial
                node.setOwner(device.get('name', 'Meshtastic'))
                
                # Позиция
                node.radioConfig.preferences.position_broadcast_secs = config.position_broadcast_secs
                if hasattr(node.radioConfig.preferences, 'gps_update_interval'):
                    node.radioConfig.preferences.gps_update_interval = config.gps_update_interval
                
                # Питание
                node.radioConfig.preferences.wait_bluetooth_secs = config.power_wait_bluetooth_secs
                node.radioConfig.moduleConfig.rangeTest.enabled = config.range_test_enabled
                # LoRa
                node.radioConfig.preferences.tx_power = config.lora_tx_power
                node.radioConfig.preferences.modem_preset = config.lora_modem_preset
                
                interface.close()
                logger.info(f"Конфигурация обновлена на {device['serial_port']} (Serial)")
                return {"success": True, "data": {"message": "Конфигурация применена через Serial"}}
            else:
                return {"success": False, "error": "Не удалось подключиться к порту"}
        except Exception as e:
            logger.error(f"Ошибка настройки через serial: {e}")
            return {"success": False, "error": str(e)}

@app.post("/api/devices/{identifier}/reboot")
async def reboot_device(identifier: str):
    """Перезагрузка устройства"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    if device['connection_type'] == 'wifi':
        result = send_device_request(device['ip'], "/api/v1/reboot", method="POST")
        return result
    
    elif device['connection_type'] == 'serial':
        if not MESHTASTIC_LIB_AVAILABLE:
            return {"success": False, "error": "Библиотека meshtastic не установлена"}
        
        try:
            interface = get_serial_interface(device['serial_port'])
            if interface:
                interface.localNode.reboot()
                interface.close()
                return {"success": True, "data": {"message": "Команда перезагрузки отправлена"}}
            else:
                return {"success": False, "error": "Не удалось подключиться к порту"}
        except Exception as e:
            return {"success": False, "error": str(e)}

@app.post("/api/devices/{identifier}/message")
async def send_message(identifier: str, req: MessageRequest):
    """Отправка текстового сообщения"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    payload = {"to": req.node_id, "message": req.message}
    
    if device['connection_type'] == 'wifi':
        result = send_device_request(device['ip'], "/api/v1/message", method="POST", json_data=payload)
        return result
    
    elif device['connection_type'] == 'serial':
        if not MESHTASTIC_LIB_AVAILABLE:
            return {"success": False, "error": "Библиотека meshtastic не установлена"}
        
        try:
            interface = get_serial_interface(device['serial_port'])
            if interface:
                interface.sendText(req.message, destinationId=req.node_id)
                interface.close()
                return {"success": True, "data": {"message": "Сообщение отправлено"}}
            else:
                return {"success": False, "error": "Не удалось подключиться к порту"}
        except Exception as e:
            return {"success": False, "error": str(e)}

@app.get("/api/serial/ports")
async def list_serial_ports():
    """Получить список доступных COM-портов"""
    return get_available_serial_ports()

@app.get("/api/logs")
async def list_logs():
    """Список доступных логов"""
    files = sorted(os.listdir(LOGS_DIR), reverse=True)
    return [{"filename": f, "size": os.path.getsize(os.path.join(LOGS_DIR, f))} for f in files if f.endswith('.log')]

@app.get("/api/logs/{filename}")
async def download_log(filename: str):
    """Скачивание файла лога"""
    filepath = os.path.join(LOGS_DIR, filename)
    if not os.path.exists(filepath) or not filename.endswith('.log'):
        raise HTTPException(status_code=404, detail="Лог не найден")
    return FileResponse(filepath, media_type='text/plain', filename=filename)

@app.post("/api/logs/export/{identifier}")
async def export_logs(identifier: str, background_tasks: BackgroundTasks):
    """Экспорт логов с устройства"""
    devices = load_devices()
    device = next((d for d in devices if d.get('ip') == identifier or d.get('serial_port') == identifier), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_id = identifier.replace('.', '_').replace('/', '_')
    filename = f"device_{safe_id}_{timestamp}.log"
    filepath = os.path.join(LOGS_DIR, filename)
    
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(f"=== Meshtastic Log Export ===\n")
            f.write(f"Device: {device['name']}\n")
            f.write(f"Connection: {device['connection_type']}\n")
            f.write(f"Identifier: {identifier}\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n\n")
            
            if device['connection_type'] == 'wifi':
                info = send_device_request(device['ip'], "/api/v1/info")
                nodes = send_device_request(device['ip'], "/api/v1/nodes")
                f.write("=== Device Info (WiFi) ===\n")
                f.write(json.dumps(info, indent=2, ensure_ascii=False))
                f.write("\n\n=== Known Nodes ===\n")
                f.write(json.dumps(nodes, indent=2, ensure_ascii=False))
            
            elif device['connection_type'] == 'serial':
                if MESHTASTIC_LIB_AVAILABLE:
                    interface = get_serial_interface(device['serial_port'])
                    if interface:
                        node = interface.localNode
                        f.write("=== Device Info (Serial) ===\n")
                        f.write(f"Node ID: {node.getNodeNum()}\n")
                        f.write(f"HW Model: {node.hwModel}\n")
                        interface.close()
        
        logger.info(f"Лог экспортирован: {filename}")
        return {"status": "success", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok", 
        "timestamp": datetime.now().isoformat(),
        "meshtastic_lib": MESHTASTIC_LIB_AVAILABLE
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)