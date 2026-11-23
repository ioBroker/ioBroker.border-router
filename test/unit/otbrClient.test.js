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

/** Complete datasets of two networks, like otbr-agent creates them */
function fullDataset(extPanId, name) {
    return [
        '0E080000000000010000',
        '000300000F',
        '35060004001FFFE0',
        `0208${extPanId}`,
        '0708FD11223344556677',
        '051000112233445566778899AABBCCDDEEFF',
        `03${Buffer.byteLength(name).toString(16).padStart(2, '0')}${Buffer.from(name).toString('hex')}`.toUpperCase(),
        '01021234',
        '0410445F2B5CA6F2A93A55CE570A70EFEECB',
        '0C0402A0F7F8',
    ].join('');
}
const NETWORK_A = fullDataset('1122334455667788', 'ioBroker');
const NETWORK_B = fullDataset('AABBCCDDEEFF0011', 'Home');

/** A fake otbr-agent with state: like the real one it takes an active dataset only while Thread is disabled */
function statefulServer(state) {
    return startServer({
        'GET /node': () => [200, 'application/json', JSON.stringify({ state: state.role })],
        'GET /node/dataset/active': () => (state.dataset ? [200, 'text/plain', state.dataset] : [204]),
        'PUT /node/state': body => {
            state.role = JSON.parse(body) === 'enable' ? 'leader' : 'disabled';
            return [200];
        },
        'PUT /node/dataset/active': body => {
            if (state.role !== 'disabled') {
                return [409, 'application/json', '{"ErrorCode":409}'];
            }
            if (state.refuse) {
                return [400, 'application/json', '{"ErrorCode":400}'];
            }
            const created = !state.dataset;
            state.dataset = body;
            return [created ? 201 : 200];
        },
    });
}

describe('OtbrClient.importActiveDataset', () => {
    let fake;
    afterEach(() => {
        fake?.server.close();
        fake = undefined;
    });

    const calls = () => fake.requests.filter(r => r.method === 'PUT').map(r => `${r.url} ${r.body.slice(0, 12)}`);

    it('sets the dataset as TLV hex with the exact content type text/plain and starts Thread', async () => {
        const state = { role: 'disabled', dataset: null };
        fake = await statefulServer(state);
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.importActiveDataset(NETWORK_A, false), 'imported');
        const put = fake.requests.find(r => r.method === 'PUT' && r.url === '/node/dataset/active');
        assert.equal(put.headers['content-type'], 'text/plain');
        assert.equal(put.body, NETWORK_A);
        assert.equal(state.role, 'leader');
        assert.deepEqual(calls(), [`/node/dataset/active ${NETWORK_A.slice(0, 12)}`, '/node/state "enable"']);
    });

    it('does nothing if the border router uses the dataset already, also in another TLV order', async () => {
        const state = { role: 'leader', dataset: NETWORK_A };
        fake = await statefulServer(state);
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        const reordered = NETWORK_A.slice(20) + NETWORK_A.slice(0, 20);
        assert.equal(await client.importActiveDataset(reordered.toLowerCase(), false), 'unchanged');
        assert.deepEqual(calls(), []);
    });

    it('does not replace another network without permission', async () => {
        const state = { role: 'leader', dataset: NETWORK_A };
        fake = await statefulServer(state);
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        await assert.rejects(
            client.importActiveDataset(NETWORK_B, false),
            e => e instanceof OtbrError && e.status === 412 && /ioBroker/.test(e.message),
        );
        assert.deepEqual(calls(), []);
        assert.equal(state.dataset, NETWORK_A);
    });

    it('stops a running network to replace it and starts the new one', async () => {
        const state = { role: 'leader', dataset: NETWORK_A };
        fake = await statefulServer(state);
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        assert.equal(await client.importActiveDataset(NETWORK_B, true), 'replaced');
        assert.equal(state.dataset, NETWORK_B);
        assert.equal(state.role, 'leader');
        assert.deepEqual(calls(), [
            '/node/state "disable"',
            `/node/dataset/active ${NETWORK_B.slice(0, 12)}`,
            '/node/state "enable"',
        ]);
    });

    it('starts the former network again if the dataset is refused', async () => {
        const state = { role: 'leader', dataset: NETWORK_A, refuse: true };
        fake = await statefulServer(state);
        const client = new OtbrClient(`http://127.0.0.1:${fake.port}`);
        await assert.rejects(client.importActiveDataset(NETWORK_B, true), e => e.status === 400);
        assert.equal(state.dataset, NETWORK_A);
        assert.equal(state.role, 'leader');
    });
});
