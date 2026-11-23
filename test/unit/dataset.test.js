const assert = require('node:assert/strict');
const {
    chooseChannel,
    defaultNetworkName,
    isSameDataset,
    isValidChannel,
    isValidNetworkName,
    normalizeImportDataset,
    parseDataset,
    parseNode,
    roleName,
} = require('../../build/lib/dataset');

// A dataset like otbr-agent creates it
const DATASET = [
    '0E080000000000010000', // active timestamp 1
    '000300000F', // channel 15
    '35060004001FFFE0', // channel mask
    '02081122334455667788', // extended PAN ID
    '0708FD11223344556677', // mesh local prefix
    '051000112233445566778899AABBCCDDEEFF', // network key
    '0308696F42726F6B6572', // network name "ioBroker"
    '01021234', // PAN ID
    '0410445F2B5CA6F2A93A55CE570A70EFEECB', // PSKc
    '0C0402A0F7F8', // security policy
].join('');

describe('dataset', () => {
    it('decodes the public fields', () => {
        assert.deepEqual(parseDataset(DATASET), {
            activeTimestamp: 1,
            channel: 15,
            extPanId: '1122334455667788',
            meshLocalPrefix: 'fd11:2233:4455:6677::/64',
            hasNetworkKey: true,
            networkName: 'ioBroker',
            panId: 0x1234,
        });
    });

    it('accepts lower case and white space', () => {
        assert.equal(parseDataset(` ${DATASET.toLowerCase()}\n`).networkName, 'ioBroker');
    });

    it('never returns the network key or the PSKc', () => {
        const text = JSON.stringify(parseDataset(DATASET));
        assert.ok(!text.includes('00112233445566778899'));
        assert.ok(!text.toUpperCase().includes('445F2B5C'));
    });

    it('rejects broken datasets', () => {
        assert.throws(() => parseDataset('xyz'), /hex/);
        assert.throws(() => parseDataset('0310696F'), /exceeds/);
    });
});

describe('node', () => {
    it('maps roles', () => {
        assert.equal(roleName('leader'), 'leader');
        assert.equal(roleName('Router'), 'router');
        assert.equal(roleName(0), 'disabled');
        assert.equal(roleName(4), 'leader');
        assert.equal(roleName('offline'), 'disabled');
        assert.equal(roleName('strange'), 'unknown');
        assert.equal(roleName(undefined), 'unknown');
    });

    const expected = {
        role: 'leader',
        networkName: 'ioBroker-1a2b',
        extPanId: '1122334455667788',
        rloc16: '0x6c00',
        routers: 1,
        borderAgentId: '0123456789ABCDEF0123456789ABCDEF',
        extAddress: 'AABBCCDDEEFF0011',
    };

    it('reads the camelCase answer of current builds', () => {
        const node = parseNode({
            baId: '0123456789abcdef0123456789abcdef',
            state: 'leader',
            routerCount: 1,
            rlocAddress: 'fd11:2233:4455:6677:0:ff:fe00:6c00',
            extAddress: 'aabbccddeeff0011',
            networkName: 'ioBroker-1a2b',
            rloc16: 27648,
            leaderData: { partitionId: 1 },
            extPanId: '1122334455667788',
        });
        assert.deepEqual(node, expected);
    });

    it('reads the PascalCase answer of builds before 2024', () => {
        const node = parseNode({
            BaId: '0123456789ABCDEF0123456789ABCDEF',
            State: 'leader',
            NumOfRouter: 1,
            ExtAddress: 'AABBCCDDEEFF0011',
            NetworkName: 'ioBroker-1a2b',
            Rloc16: 27648,
            ExtPanId: '1122334455667788',
        });
        assert.deepEqual(node, expected);
    });

    it('rejects non objects', () => {
        assert.throws(() => parseNode('leader'), /object/);
        assert.throws(() => parseNode(null), /object/);
    });
});

describe('network parameters', () => {
    it('limits the network name to 16 bytes', () => {
        assert.ok(isValidNetworkName('ioBroker-1234567'));
        assert.ok(!isValidNetworkName('ioBroker-12345678'));
        // 16 characters, but 21 bytes in UTF-8
        assert.ok(!isValidNetworkName('Wohnzimmer-ÄÖÜäö'));
        assert.ok(!isValidNetworkName(''));
    });

    it('accepts the channels 11 to 26', () => {
        assert.ok(isValidChannel(11));
        assert.ok(isValidChannel(26));
        assert.ok(!isValidChannel(10));
        assert.ok(!isValidChannel(27));
        assert.ok(!isValidChannel(15.5));
    });

    it('chooses a channel between the Wi-Fi channels, not used by Zigbee', () => {
        assert.equal(chooseChannel([]), 25);
        assert.equal(chooseChannel([11]), 25);
        assert.equal(chooseChannel([25]), 15);
        assert.equal(chooseChannel([25, 15]), 20);
        assert.equal(chooseChannel([25, 15, 20]), 25);
    });

    it('generates a network name', () => {
        assert.equal(defaultNetworkName('3FA2C1'), 'ioBroker-3fa2');
        assert.ok(isValidNetworkName(defaultNetworkName('ffff')));
    });
});

describe('dataset import', () => {
    it('accepts white space, line breaks, lower case and 0x', () => {
        const pasted = `0x${DATASET.slice(0, 30).toLowerCase()}\n  ${DATASET.slice(30)} `;
        const { dataset, info } = normalizeImportDataset(pasted);
        assert.equal(dataset, DATASET);
        assert.equal(info.networkName, 'ioBroker');
        assert.equal(info.channel, 15);
    });

    it('refuses incomplete datasets', () => {
        // without network key
        const withoutKey = DATASET.replace('051000112233445566778899AABBCCDDEEFF', '');
        assert.throws(() => normalizeImportDataset(withoutKey), /network key/);
        assert.throws(() => normalizeImportDataset('0308696F42726F6B6572'), /network key, channel, PAN ID/);
        assert.throws(() => normalizeImportDataset(' '), /empty/);
        assert.throws(() => normalizeImportDataset('xyz'), /hex/);
    });

    it('refuses channels a border router does not support', () => {
        assert.throws(() => normalizeImportDataset(DATASET.replace('000300000F', '000300000A')), /channel 10/);
    });

    it('compares datasets independent of the TLV order and the case', () => {
        const reordered = DATASET.slice(20) + DATASET.slice(0, 20);
        assert.ok(isSameDataset(DATASET, reordered.toLowerCase()));
        assert.ok(!isSameDataset(DATASET, DATASET.replace('01021234', '01021235')));
        assert.ok(!isSameDataset(DATASET, DATASET.replace('01021234', '')));
        assert.ok(!isSameDataset(DATASET, 'xyz'));
    });
});
