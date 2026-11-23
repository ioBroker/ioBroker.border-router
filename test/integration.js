const path = require('node:path');
const { tests } = require('@iobroker/testing');

// The adapter must start without Docker and without a border router, and without errors
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    defineAdditionalTests({ suite }) {
        suite('Start without a border router', getHarness => {
            it('runs and reports no connection', async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.changeAdapterConfig('border-router', {
                    native: { dockerEnabled: false, externalUrl: 'http://127.0.0.1:18091', pollInterval: 5 },
                });
                await harness.startAdapterAndWait();
                await new Promise(resolve => setTimeout(resolve, 8000));
                if (!harness.isAdapterRunning()) {
                    throw new Error('Adapter is not running');
                }
                const connection = await harness.states.getStateAsync('border-router.0.info.connection');
                if (connection && connection.val !== false) {
                    throw new Error('info.connection must be false without a border router');
                }
            });
        });
    },
});
