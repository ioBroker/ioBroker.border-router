"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtbrClient = exports.OtbrError = void 0;
const dataset_1 = require("./dataset");
/** Error of a request to the REST API of otbr-agent; `status` is 0 if the server could not be reached */
class OtbrError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'OtbrError';
    }
    get unreachable() {
        return this.status === 0;
    }
}
exports.OtbrError = OtbrError;
const DEFAULT_TIMEOUT = 5000;
/**
 * Minimal client for the REST API of otbr-agent (ot-br-posix `src/rest/openapi.yaml`).
 * Only the endpoints under `/node` are used: they exist in all builds since 2022.
 */
class OtbrClient {
    baseUrl;
    timeout;
    constructor(baseUrl, timeout = DEFAULT_TIMEOUT) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeout = timeout;
    }
    async request(method, path, options = {}) {
        const headers = { Accept: options.accept || 'application/json', ...options.headers };
        if (options.body !== undefined) {
            headers['Content-Type'] = options.contentType || 'application/json';
        }
        let response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: options.body,
                signal: AbortSignal.timeout(this.timeout),
            });
        }
        catch (e) {
            const cause = e.cause?.code;
            throw new OtbrError(`${method} ${path}: ${cause || e.message}`, 0);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new OtbrError(`${method} ${path} returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`, response.status);
        }
        return { status: response.status, text };
    }
    async getJson(path) {
        const { text } = await this.request('GET', path);
        try {
            return JSON.parse(text);
        }
        catch {
            throw new OtbrError(`GET ${path} returned no JSON`, 500);
        }
    }
    /** Role, network name, extended PAN ID and more of this border router */
    async getNode() {
        return (0, dataset_1.parseNode)(await this.getJson('/node'));
    }
    /** The active operational dataset as TLV hex string, or null if the border router has none yet */
    async getActiveDataset() {
        const { status, text } = await this.request('GET', '/node/dataset/active', { accept: 'text/plain' });
        if (status === 204 || !text.trim()) {
            return null;
        }
        // some builds put the hex string into quotes
        const hex = text.trim().replace(/^"|"$/g, '');
        if (!(0, dataset_1.isHex)(hex)) {
            throw new OtbrError('GET /node/dataset/active returned no hex string', 500);
        }
        return hex.toUpperCase();
    }
    /** Firmware version of the radio co-processor (RCP), e.g. `SL-OPENTHREAD/2.4.4.0_GitHub-7074a43e4; EFR32; ...` */
    async getCoprocessorVersion() {
        const value = await this.getJson('/node/coprocessor/version');
        return typeof value === 'string' ? value : JSON.stringify(value);
    }
    /** Start or stop the Thread stack */
    async setThreadEnabled(enabled) {
        await this.request('PUT', '/node/state', { body: JSON.stringify(enabled ? 'enable' : 'disable') });
    }
    /**
     * Create the active dataset, only if there is none (`If-None-Match: *`). otbr-agent fills all fields that are
     * not given with random values: network key, PSKc, PAN ID, extended PAN ID, mesh local prefix.
     *
     * @returns false if a dataset exists already
     */
    async createActiveDataset(options) {
        const camel = { networkName: options.networkName };
        if (options.channel) {
            camel.channel = options.channel;
        }
        try {
            await this.putDataset(camel);
        }
        catch (e) {
            if (e instanceof OtbrError && e.status === 412) {
                return false;
            }
            if (!(e instanceof OtbrError) || e.status !== 400) {
                throw e;
            }
            // builds before 2024 expect PascalCase keys
            const pascal = { NetworkName: options.networkName };
            if (options.channel) {
                pascal.Channel = options.channel;
            }
            await this.putDataset(pascal);
        }
        return true;
    }
    /**
     * Use an existing dataset (TLV hex), e.g. to join the Thread network of another border router.
     *
     * otbr-agent takes an active dataset only while Thread is stopped (409 otherwise): a running network is
     * stopped for it, and started again also if the dataset is refused.
     *
     * @param dataset complete operational dataset, upper case hex
     * @param replace whether an existing, different network of this border router may be replaced
     * @returns `unchanged` if the border router uses this dataset already
     */
    async importActiveDataset(dataset, replace) {
        const current = await this.getActiveDataset();
        if (current && (0, dataset_1.isSameDataset)(current, dataset)) {
            return 'unchanged';
        }
        if (current && !replace) {
            throw new OtbrError(`The border router has the Thread network "${(0, dataset_1.parseDataset)(current).networkName}" already. Allow to replace it.`, 412);
        }
        const running = (await this.getNode()).role !== 'disabled';
        if (running) {
            await this.setThreadEnabled(false);
        }
        try {
            // the exact content type "text/plain" selects the TLV format, fetch would add a charset
            await this.request('PUT', '/node/dataset/active', { body: dataset, contentType: 'text/plain' });
        }
        catch (e) {
            if (running) {
                await this.setThreadEnabled(true).catch(() => undefined);
            }
            throw e;
        }
        await this.setThreadEnabled(true);
        const now = await this.getActiveDataset();
        if (!now || (0, dataset_1.parseDataset)(now).extPanId !== (0, dataset_1.parseDataset)(dataset).extPanId) {
            throw new OtbrError('The border router did not take the dataset', 500);
        }
        return current ? 'replaced' : 'imported';
    }
    async putDataset(body) {
        await this.request('PUT', '/node/dataset/active', {
            body: JSON.stringify(body),
            headers: { 'If-None-Match': '*' },
        });
    }
}
exports.OtbrClient = OtbrClient;
//# sourceMappingURL=otbrClient.js.map