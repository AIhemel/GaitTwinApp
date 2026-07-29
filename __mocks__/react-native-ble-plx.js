class BleManager {
  startDeviceScan() {}
  stopDeviceScan() {}
  writeCharacteristicWithResponseForDevice() {
    return Promise.resolve();
  }
}

module.exports = { BleManager };
