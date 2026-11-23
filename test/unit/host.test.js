const assert = require('node:assert/strict');
const {
    checkHostSettings,
    describeStick,
    detectDefaultInterface,
    isUsableDevicePath,
} = require('../../build/lib/host');

const ROUTE_HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';

describe('host', () => {
    it('finds the interface of the default route', () => {
        const table = [
            ROUTE_HEADER,
            'docker0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
            'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
            'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
            'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
        ].join('\n');
        assert.equal(detectDefaultInterface(table), 'eth0');
    });

    it('ignores routes that are down and finds nothing without a default route', () => {
        const table = [ROUTE_HEADER, 'eth0\t00000000\t0101A8C0\t0002\t0\t0\t100\t00000000\t0\t0\t0'].join('\n');
        assert.equal(detectDefaultInterface(table), undefined);
        assert.equal(detectDefaultInterface(ROUTE_HEADER), undefined);
    });

    it('recognizes the usual sticks', () => {
        assert.equal(
            describeStick('/dev/serial/by-id/usb-Nabu_Casa_SkyConnect_v1.0_3c0ed67c-if00-port0').flowControl,
            true,
        );
        const dongleE = describeStick('usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_20230509111242-if00');
        assert.match(dongleE.name, /ZBDongle-E/);
        assert.equal(dongleE.baudRate, 460800);
        assert.equal(dongleE.warning, undefined);
        const dongleP = describeStick('usb-Silicon_Labs_Sonoff_Zigbee_3.0_USB_Dongle_Plus_0001-if00-port0');
        assert.match(dongleP.name, /CC2652P/);
        assert.ok(dongleP.warning);
        assert.equal(describeStick('usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0'), undefined);
    });

    it('does not hand the regular expression of a stick to the caller', () => {
        assert.equal(describeStick('SkyConnect').pattern, undefined);
    });

    it('accepts only device paths docker can map', () => {
        assert.ok(isUsableDevicePath('/dev/serial/by-id/usb-Nabu_Casa_SkyConnect_v1.0_3c0e-if00-port0'));
        assert.ok(isUsableDevicePath('/dev/ttyUSB0'));
        assert.ok(!isUsableDevicePath('/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0'));
        assert.ok(!isUsableDevicePath('ttyUSB0'));
        assert.ok(!isUsableDevicePath('/dev/tty USB0'));
    });

    it('reports missing kernel settings', async () => {
        const values = {
            '/proc/sys/net/ipv6/conf/all/forwarding': '0\n',
            '/proc/sys/net/ipv6/conf/eth0/accept_ra': '1\n',
            '/proc/sys/net/ipv6/conf/eth0/accept_ra_rt_info_max_plen': '0\n',
        };
        const read = async path => {
            if (!(path in values)) {
                throw new Error('ENOENT');
            }
            return values[path];
        };
        assert.deepEqual(await checkHostSettings('eth0', read), [
            'net.ipv6.conf.all.forwarding=1',
            'net.ipv6.conf.eth0.accept_ra=2',
            'net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64',
        ]);
        values['/proc/sys/net/ipv6/conf/all/forwarding'] = '1';
        values['/proc/sys/net/ipv6/conf/eth0/accept_ra'] = '2';
        values['/proc/sys/net/ipv6/conf/eth0/accept_ra_rt_info_max_plen'] = '64';
        assert.deepEqual(await checkHostSettings('eth0', read), []);
        // not Linux: nothing can be read, nothing is reported
        assert.deepEqual(await checkHostSettings('eth1', read), []);
    });
});
