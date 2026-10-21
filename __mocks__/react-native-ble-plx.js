class BleManager {
  startDeviceScan() {}
  stopDeviceScan() {}
  cancelDeviceConnection() {
    return Promise.resolve();
  }
  readRSSIForDevice(id) {
    return Promise.resolve({ id, rssi: -60 });
  }
  writeCharacteristicWithResponseForDevice() {
    return Promise.resolve();
  }
}

const ConnectionPriority = { Balanced: 0, High: 1, LowPower: 2 };

module.exports = { BleManager, ConnectionPriority };
