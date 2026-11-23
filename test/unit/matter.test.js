const assert = require('node:assert/strict');
const { datasetFingerprint, mergeThreadCredentials } = require('../../build/lib/matter');

const OURS = '0E0800000000000100000003000019';
const OURS_NEW = '0E0800000000000200000003000014';
const FOREIGN = '0E080000000000050000000300000F';

describe('hand-over to ioBroker.matter', () => {
    it('fills an empty default network and keeps the other settings', () => {
        const result = mergeThreadCredentials({ enabled: true, ble: true }, 'ioBroker-1a2b', OURS, 'border-router.0');
        assert.equal(result.target, 'default');
        assert.equal(result.changed, true);
        assert.deepEqual(result.native, {
            enabled: true,
            ble: true,
            threadNetworkName: 'ioBroker-1a2b',
            threadOperationalDataSet: OURS,
        });
    });

    it('reports no change for the same dataset, independent of the case', () => {
        const result = mergeThreadCredentials(
            { threadNetworkName: 'ioBroker-1a2b', threadOperationalDataSet: OURS.toLowerCase() },
            'ioBroker-1a2b',
            OURS,
            'border-router.0',
        );
        assert.equal(result.changed, false);
        assert.equal(result.target, 'default');
    });

    it('replaces its own former network', () => {
        const fingerprint = datasetFingerprint(OURS);
        const result = mergeThreadCredentials(
            { threadNetworkName: 'ioBroker-1a2b', threadOperationalDataSet: OURS },
            'ioBroker-9999',
            OURS_NEW,
            'border-router.0',
            ds => datasetFingerprint(ds) === fingerprint,
        );
        assert.equal(result.target, 'default');
        assert.equal(result.changed, true);
        assert.equal(result.native.threadOperationalDataSet, OURS_NEW);
    });

    it('keeps a network entered by hand and adds its own one', () => {
        const current = {
            threadNetworkName: 'Apple',
            threadOperationalDataSet: FOREIGN,
            additionalThreadCredentials: [{ id: 'other', networkName: 'x', operationalDataset: 'AA' }],
        };
        const result = mergeThreadCredentials(current, 'ioBroker-1a2b', OURS, 'border-router.0');
        assert.equal(result.target, 'additional');
        assert.equal(result.changed, true);
        assert.equal(result.native.threadOperationalDataSet, FOREIGN);
        assert.deepEqual(result.native.additionalThreadCredentials, [
            { id: 'other', networkName: 'x', operationalDataset: 'AA' },
            { id: 'border-router.0', networkName: 'ioBroker-1a2b', operationalDataset: OURS },
        ]);
        // the input is not modified
        assert.equal(current.additionalThreadCredentials.length, 1);

        const again = mergeThreadCredentials(result.native, 'ioBroker-1a2b', OURS, 'border-router.0');
        assert.equal(again.changed, false);
        assert.equal(again.native.additionalThreadCredentials.length, 2);

        const updated = mergeThreadCredentials(result.native, 'ioBroker-9999', OURS_NEW, 'border-router.0');
        assert.equal(updated.changed, true);
        assert.deepEqual(updated.native.additionalThreadCredentials[1], {
            id: 'border-router.0',
            networkName: 'ioBroker-9999',
            operationalDataset: OURS_NEW,
        });
    });

    it('creates a fingerprint that does not contain the dataset', () => {
        const fingerprint = datasetFingerprint(OURS);
        assert.match(fingerprint, /^[0-9a-f]{64}$/);
        assert.equal(fingerprint, datasetFingerprint(` ${OURS.toLowerCase()} `));
        assert.notEqual(fingerprint, datasetFingerprint(OURS_NEW));
    });
});
