const assert = require('node:assert/strict');
const { findPortUsers, zigbeeChannels } = require('../../build/lib/conflicts');

const PORT = '/dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_2023-if00-port0';

const instances = [
    { _id: 'system.adapter.border-router.0', common: { enabled: true }, native: { serialPort: PORT } },
    { _id: 'system.adapter.zigbee.0', common: { enabled: true }, native: { port: '/dev/ttyUSB0', channel: 11 } },
    { _id: 'system.adapter.zigbee.1', common: { enabled: false }, native: { port: PORT, channel: '25' } },
    { _id: 'system.adapter.enocean.0', common: { enabled: true }, native: { serial: { path: ` ${PORT} ` } } },
    { _id: 'system.adapter.admin.0', common: { enabled: true }, native: { port: 8081 } },
];

describe('conflicts', () => {
    it('finds enabled instances using the same port, also nested and by the resolved device', () => {
        assert.deepEqual(findPortUsers(instances, [PORT, '/dev/ttyUSB0'], 'system.adapter.border-router.0'), [
            'zigbee.0',
            'enocean.0',
        ]);
    });

    it('ignores the own instance and disabled ones', () => {
        assert.deepEqual(findPortUsers(instances.slice(0, 3), [PORT, ''], 'system.adapter.border-router.0'), []);
    });

    it('finds nothing without a port', () => {
        assert.deepEqual(findPortUsers(instances, ['', ''], 'system.adapter.border-router.0'), []);
    });

    it('collects the Zigbee channels', () => {
        assert.deepEqual(zigbeeChannels(instances), [11, 25]);
    });
});
