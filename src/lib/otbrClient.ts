import { isHex, parseNode, type NodeInfo } from './dataset';

/** Error of a request to the REST API of otbr-agent; `status` is 0 if the server could not be reached */
export class OtbrError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = 'OtbrError';
    }

    public get unreachable(): boolean {
        return this.status === 0;
    }
}

export interface CreateDatasetOptions {
    networkName: string;
    /** 11..26, or undefined to let otbr-agent choose */
    channel?: number;
}

const DEFAULT_TIMEOUT = 5000;

/**
 * Minimal client for the REST API of otbr-agent (ot-br-posix `src/rest/openapi.yaml`).
 * Only the endpoints under `/node` are used: they exist in all builds since 2022.
 */
export class OtbrClient {
    public readonly baseUrl: string;
    private readonly timeout: number;

    public constructor(baseUrl: string, timeout = DEFAULT_TIMEOUT) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeout = timeout;
    }

    private async request(
        method: 'GET' | 'PUT',
        path: string,
        options: { accept?: string; body?: string; contentType?: string; headers?: Record<string, string> } = {},
    ): Promise<{ status: number; text: string }> {
        const headers: Record<string, string> = { Accept: options.accept || 'application/json', ...options.headers };
        if (options.body !== undefined) {
            headers['Content-Type'] = options.contentType || 'application/json';
        }
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: options.body,
                signal: AbortSignal.timeout(this.timeout),
            });
        } catch (e) {
            const cause = (e as { cause?: { code?: string } }).cause?.code;
            throw new OtbrError(`${method} ${path}: ${cause || (e as Error).message}`, 0);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new OtbrError(
                `${method} ${path} returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
                response.status,
            );
        }
        return { status: response.status, text };
    }

    private async getJson(path: string): Promise<unknown> {
        const { text } = await this.request('GET', path);
        try {
            return JSON.parse(text);
        } catch {
            throw new OtbrError(`GET ${path} returned no JSON`, 500);
        }
    }

    /** Role, network name, extended PAN ID and more of this border router */
    public async getNode(): Promise<NodeInfo> {
        return parseNode(await this.getJson('/node'));
    }

    /** The active operational dataset as TLV hex string, or null if the border router has none yet */
    public async getActiveDataset(): Promise<string | null> {
        const { status, text } = await this.request('GET', '/node/dataset/active', { accept: 'text/plain' });
        if (status === 204 || !text.trim()) {
            return null;
        }
        // some builds put the hex string into quotes
        const hex = text.trim().replace(/^"|"$/g, '');
        if (!isHex(hex)) {
            throw new OtbrError('GET /node/dataset/active returned no hex string', 500);
        }
        return hex.toUpperCase();
    }

    /** Firmware version of the radio co-processor (RCP), e.g. `SL-OPENTHREAD/2.4.4.0_GitHub-7074a43e4; EFR32; ...` */
    public async getCoprocessorVersion(): Promise<string> {
        const value = await this.getJson('/node/coprocessor/version');
        return typeof value === 'string' ? value : JSON.stringify(value);
    }

    /** Start or stop the Thread stack */
    public async setThreadEnabled(enabled: boolean): Promise<void> {
        await this.request('PUT', '/node/state', { body: JSON.stringify(enabled ? 'enable' : 'disable') });
    }

    /**
     * Create the active dataset, only if there is none (`If-None-Match: *`). otbr-agent fills all fields that are
     * not given with random values: network key, PSKc, PAN ID, extended PAN ID, mesh local prefix.
     *
     * @returns false if a dataset exists already
     */
    public async createActiveDataset(options: CreateDatasetOptions): Promise<boolean> {
        const camel: Record<string, unknown> = { networkName: options.networkName };
        if (options.channel) {
            camel.channel = options.channel;
        }
        try {
            await this.putDataset(camel);
        } catch (e) {
            if (e instanceof OtbrError && e.status === 412) {
                return false;
            }
            if (!(e instanceof OtbrError) || e.status !== 400) {
                throw e;
            }
            // builds before 2024 expect PascalCase keys
            const pascal: Record<string, unknown> = { NetworkName: options.networkName };
            if (options.channel) {
                pascal.Channel = options.channel;
            }
            await this.putDataset(pascal);
        }
        return true;
    }

    private async putDataset(body: Record<string, unknown>): Promise<void> {
        await this.request('PUT', '/node/dataset/active', {
            body: JSON.stringify(body),
            headers: { 'If-None-Match': '*' },
        });
    }
}
