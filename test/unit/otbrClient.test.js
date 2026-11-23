const assert = require('node:assert/strict');
const http = require('node:http');
const { OtbrClient, OtbrError } = require('../../build/lib/otbrClient');

const DATASET = '0E08000000000001000000030000190308696F42726F6B6572';

/** A fake otbr-agent: records the requests, answers from `handlers` */
function startServer(handlers) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            const handler = handlers[`${req.method} ${req.url}`];
            if (!handler) {
                res.writeHead(404).end();
                return;
            }
            const [status, contentType, text] = handler(body);
            res.writeHead(status, contentType ? { 'Content-Type': contentType } : {}).end(text);
        });
    });
    return new Promise(resolve =>
        server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })),
    );
}

describe('OtbrClient', () => {
    let fake;
    afterEach(() => {
        fake?.server.close();
        fake = undefined;
    });

    it('reads node, dataset and firmware version', async () => {
        fake = await startServer({
            'GET /node': () => [
                200,
                'application/json',
                JSON.stringify({ state: 'router', networkName: 'x', extPanId: 'ab' }),
            ],
            'GET /node/dataset/active': () => [200, 'text/plain', DATASET.toLowerCase()],
            'GET /node/coprocessor/version': () => [200, 'application/json', '"OPENTHREAD/1.4; EFR32"'],
        });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}/`);
        assert.equal((await client.getNode()).role, 'router');
        assert.equal(await client.getActiveDataset(), DATASET);
        assert.equal(await client.getCoprocessorVersion(), 'OPENTHREAD/1.4; EFR32');
        const datasetRequest = fake.requests.find(r => r.url === '/node/dataset/active');
        assert.equal(datasetRequest.headers.accept, 'text/plain');
    });

    it('returns null if there is no dataset', async () => {
        fake = await startServer({ 'GET /node/dataset/active': () => [204] });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.getActiveDataset(), null);
    });

    it('starts and stops Thread', async () => {
        fake = await startServer({ 'PUT /node/state': () => [200] });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        await client.setThreadEnabled(true);
        await client.setThreadEnabled(false);
        assert.deepEqual(
            fake.requests.map(r => r.body),
            ['"enable"', '"disable"'],
        );
        assert.equal(fake.requests[0].headers['content-type'], 'application/json');
    });

    it('creates a dataset only if there is none', async () => {
        fake = await startServer({ 'PUT /node/dataset/active': () => [201] });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.createActiveDataset({ networkName: 'ioBroker-1234', channel: 25 }), true);
        const request = fake.requests[0];
        assert.equal(request.headers['if-none-match'], '*');
        assert.deepEqual(JSON.parse(request.body), { networkName: 'ioBroker-1234', channel: 25 });
    });

    it('reports an existing dataset (412)', async () => {
        fake = await startServer({ 'PUT /node/dataset/active': () => [412, 'application/json', '{}'] });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.createActiveDataset({ networkName: 'x' }), false);
    });

    it('falls back to PascalCase keys for old builds', async () => {
        fake = await startServer({
            'PUT /node/dataset/active': body => (JSON.parse(body).NetworkName ? [200] : [400]),
        });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.createActiveDataset({ networkName: 'ioBroker-1234', channel: 15 }), true);
        assert.deepEqual(JSON.parse(fake.requests[1].body), { NetworkName: 'ioBroker-1234', Channel: 15 });
    });

    it('reports HTTP errors with their status', async () => {
        fake = await startServer({ 'PUT /node/state': () => [409, 'text/plain', 'Conflict'] });
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        await assert.rejects(client.setThreadEnabled(true), e => e instanceof OtbrError && e.status === 409);
    });

    it('reports an unreachable server with status 0', async () => {
        const closed = await startServer({});
        const port = closed.port;
        await new Promise(resolve => closed.server.close(resolve));
        const client = new OtbrClient(`http://127.0.0.1:${port}`, 2000);
        await assert.rejects(client.getNode(), e => e instanceof OtbrError && e.unreachable);
    });
});
