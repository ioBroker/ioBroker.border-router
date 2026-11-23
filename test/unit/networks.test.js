const assert = require('node:assert/strict');
const { chooseNetworkToJoin, collectKnownNetworks, networkLabel } = require('../../build/lib/networks');
const { datasetFingerprint } = require('../../build/lib/matter');

/** A complete dataset; `timestamp` is the active timestamp in seconds */
function dataset(extPanId, name, timestamp = 1) {
    const nameHex = Buffer.from(name).toString('hex');
    return [
        `0E08${timestamp.toString(16).padStart(12, '0')}0000`,
        '0003000019',
        `0208${extPanId}`,
        '0708FD11223344556677',
        '051000112233445566778899AABBCCDDEEFF',
        `03${(nameHex.length / 2).toString(16).padStart(2, '0')}${nameHex}`,
        '01021234',
    ]
        .join('')
        .toUpperCase();
}

const HOME = dataset('1111111111111111', 'Home');
const OWN = dataset('2222222222222222', 'ioBroker-1a2b');
const OTHER = dataset('3333333333333333', 'Office');

describe('known networks', () => {
    it('collects the networks of matter and of other border routers, skips broken ones', () => {
        const list = collectKnownNetworks(
            [
                {
                    instance: 'matter.0',
                    native: {
                        threadOperationalDataSet: HOME.toLowerCase(),
                        additionalThreadCredentials: [
                            { id: 'border-router.0', networkName: 'x', operationalDataset: OWN },
                            { id: 'broken', networkName: 'y', operationalDataset: '0308696F' },
                        ],
                    },
                },
                { instance: 'matter.1', native: {} },
            ],
            [{ instance: 'border-router.1', dataset: OTHER }],
            'border-router.0',
        );
        assert.deepEqual(
            list.map(n => [n.key, n.info.networkName, n.own]),
            [
                ['border-router.1', 'Office', false],
                ['matter.0', 'Home', false],
                ['matter.0/border-router.0', 'ioBroker-1a2b', true],
            ],
        );
        assert.equal(list[1].dataset, HOME);
    });

    it('recognizes its own network by the fingerprint of the last hand-over', () => {
        const list = collectKnownNetworks(
            [{ instance: 'matter.0', native: { threadOperationalDataSet: OWN } }],
            [],
            'border-router.0',
            datasetFingerprint(OWN),
        );
        assert.equal(list[0].own, true);
    });

    it('joins its own former network first', () => {
        const list = collectKnownNetworks(
            [
                {
                    instance: 'matter.0',
                    native: {
                        threadOperationalDataSet: HOME,
                        additionalThreadCredentials: [
                            { id: 'border-router.0', networkName: 'x', operationalDataset: OWN },
                        ],
                    },
                },
            ],
            [{ instance: 'border-router.1', dataset: OTHER }],
            'border-router.0',
        );
        assert.equal(chooseNetworkToJoin(list).network.dataset, OWN);
    });

    it('joins the only known network, also if it is known several times', () => {
        const newer = dataset('1111111111111111', 'Home', 7);
        const list = collectKnownNetworks(
            [{ instance: 'matter.0', native: { threadOperationalDataSet: HOME } }],
            [{ instance: 'border-router.1', dataset: newer }],
            'border-router.0',
        );
        const { network, networks } = chooseNetworkToJoin(list);
        assert.equal(networks.length, 1);
        // the most recent dataset of the network
        assert.equal(network.dataset, newer);
    });

    it('chooses nothing if several networks are known', () => {
        const list = collectKnownNetworks(
            [{ instance: 'matter.0', native: { threadOperationalDataSet: HOME } }],
            [{ instance: 'border-router.1', dataset: OTHER }],
            'border-router.0',
        );
        const { network, networks } = chooseNetworkToJoin(list);
        assert.equal(network, undefined);
        assert.equal(networks.length, 2);
        assert.deepEqual(chooseNetworkToJoin([]), { networks: [] });
    });

    it('shows no network key in the label', () => {
        const [network] = collectKnownNetworks(
            [{ instance: 'matter.0', native: { threadOperationalDataSet: HOME } }],
            [],
            'border-router.0',
        );
        const label = networkLabel(network);
        assert.equal(label, '"Home" (channel 25) - default Thread network of matter.0');
        assert.ok(!label.includes('00112233445566778899'));
    });
});
