import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as utils from '@iobroker/adapter-core';

import { findPortUsers, zigbeeChannels, type InstanceLike } from './lib/conflicts';
import {
    chooseChannel,
    defaultNetworkName,
    isValidChannel,
    isValidNetworkName,
    normalizeImportDataset,
    parseDataset,
    type DatasetInfo,
    type NodeInfo,
} from './lib/dataset';
import {
    checkHostSettings,
    describeStick,
    isUsableDevicePath,
    listInterfaces,
    listSerialPorts,
    readDefaultInterface,
} from './lib/host';
import { analyzeLog } from './lib/logHints';
import { datasetFingerprint, mergeThreadCredentials, type MatterControllerNative } from './lib/matter';
import {
    chooseNetworkToJoin,
    collectKnownNetworks,
    networkLabel,
    type KnownNetwork,
    type MatterController,
    type OtherBorderRouter,
} from './lib/networks';
import { OtbrClient } from './lib/otbrClient';

/** The part of the docker plugin and its manager this adapter uses */
interface DockerManagerLike {
    containerList(all?: boolean): Promise<{ names: string; status: string }[]>;
    containerLogs(containerNameOrId: string, options?: { tail?: number }): Promise<string[]>;
}

interface DockerPluginInstance {
    instanceIsReady(forceRestartOfExistingContainer?: boolean): Promise<void>;
    getDockerManager(): DockerManagerLike | null;
}

/** Poll interval while the border router is not reachable yet (image pull, container start) */
const FAST_POLL = 10_000;
/** Look into the container log after the REST API was not reachable for this long */
const DIAGNOSE_AFTER = 60_000;
const DIAGNOSE_INTERVAL = 5 * 60_000;
const MATTER_RETRY = 5 * 60_000;

function toNumber(value: number | string | undefined, def: number): number {
    const n = parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : def;
}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** A text field of a message or of the settings */
function textOf(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export class BorderRouterAdapter extends utils.Adapter {
    private client: OtbrClient | null = null;
    private pollTimer: ioBroker.Timeout | undefined;
    private polling = false;
    /** a poll was requested while one was running: the next one comes after this delay */
    private pollSoon = 0;
    private stopping = false;
    private dockerMode = false;
    private containerName = '';
    private containerRequested = false;
    private reachable = false;
    private unreachableSince = 0;
    private lastDiagnose = 0;
    private lastProblem = '';
    private lastError = '';
    private coprocessorVersion = '';
    /** active dataset (TLV hex) of the last poll */
    private dataset: string | null = null;
    private noDatasetLogged = false;
    private autoEnableDone = false;
    /** a running creation or import of the Thread network: only one at a time */
    private networkTask: Promise<unknown> | null = null;
    private matterHandedOver = '';
    private matterLastAttempt = 0;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'border-router',
            ready: () => this.main(),
            unload: callback => this.onUnload(callback),
            message: obj => this.onMessage(obj),
            stateChange: (id, state) => this.onStateChange(id, state),
        });
    }

    private async main(): Promise<void> {
        await this.setState('info.connection', false, true);
        this.dockerMode = !!this.config.dockerEnabled;

        if (this.dockerMode) {
            if (await this.initNativeOnce()) {
                return;
            }
            this.containerName = `iob_${this.namespace.replace(/[-.]/g, '_')}_otbr`;
            this.client = new OtbrClient(`http://127.0.0.1:${toNumber(this.config.restPort, 8091)}`);
            this.containerRequested = await this.startContainer();
        } else if (this.config.externalUrl) {
            this.client = new OtbrClient(this.config.externalUrl);
            this.log.info(`Using the border router at ${this.client.baseUrl}`);
        } else {
            this.log.warn(
                'Neither Docker nor the URL of an existing border router is configured. Please check the settings.',
            );
            await this.setProblem('Not configured');
            return;
        }

        await this.subscribeStatesAsync('thread.enabled');
        this.schedulePoll(1000);
    }

    /**
     * Fill the settings that are detected once.
     *
     * @returns true if the instance object was changed and the adapter will restart
     */
    private async initNativeOnce(): Promise<boolean> {
        // An image cleared in the settings is an empty string, but the compose file takes its default (the image
        // tested with this version) only for a missing value
        if (typeof this.config.dockerImage === 'string' && !this.config.dockerImage.trim()) {
            const id = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(id);
            if (obj?.native && 'dockerImage' in obj.native) {
                delete obj.native.dockerImage;
                this.log.info('Using the image tested with this version of the adapter. The instance will restart.');
                await this.setForeignObjectAsync(id, obj);
                return true;
            }
        }
        if (this.config.infraInterface) {
            return false;
        }
        const iface = await readDefaultInterface();
        if (!iface) {
            this.log.error(
                'Cannot detect the network interface of the LAN. Please select it in the settings (tab Docker).',
            );
            return false;
        }
        this.log.info(`Using the network interface ${iface} for the LAN. The instance will restart.`);
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { infraInterface: iface } });
        return true;
    }

    private async getInstances(): Promise<InstanceLike[]> {
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.\u9999',
        });
        return view.rows.map(row => row.value as InstanceLike);
    }

    /** Problems with the serial port that prevent starting the container */
    private async checkSerialPort(port: string): Promise<string | null> {
        if (!port) {
            return 'Select the serial port of the Thread stick in the settings.';
        }
        if (!isUsableDevicePath(port)) {
            return `The serial port "${port}" cannot be handed to Docker. Use the name below /dev/serial/by-id.`;
        }
        let resolved = '';
        try {
            resolved = await realpath(port);
        } catch {
            this.log.warn(`The serial port ${port} does not exist on this host (ignore this if Docker runs elsewhere)`);
        }
        const users = findPortUsers(await this.getInstances(), [port, resolved], `system.adapter.${this.namespace}`);
        if (users.length) {
            return (
                `The stick ${port} is used by ${users.join(', ')}. A stick can be used by one program only: ` +
                'Zigbee and Thread need one stick each.'
            );
        }
        return null;
    }

    private getDockerPlugin(): DockerPluginInstance | null {
        return this.getPluginInstance('docker') as DockerPluginInstance | null;
    }

    /** Check everything the container needs and let the docker plugin create and start it */
    private async startContainer(): Promise<boolean> {
        const port = (this.config.serialPort || '').trim();
        const problem = await this.checkSerialPort(port);
        if (problem) {
            this.log.error(`The border router is not started: ${problem}`);
            await this.setProblem(problem);
            return false;
        }
        const stick = describeStick(port);
        if (stick?.warning) {
            this.log.warn(`${stick.name}: ${stick.warning}`);
        } else if (stick) {
            this.log.info(`Stick: ${stick.name}`);
        }

        if (!this.config.prepareHost) {
            const missing = await checkHostSettings(this.config.infraInterface);
            if (missing.length) {
                this.log.warn(
                    `The host is not prepared for a border router. Set: ${missing.map(s => `sysctl -w ${s}`).join('; ')}` +
                        ' (or enable "Prepare the host" in the settings)',
                );
            }
        }

        const plugin = this.getDockerPlugin();
        if (!plugin) {
            this.log.error('The docker plugin is not available. js-controller 7 or newer is required.');
            return false;
        }
        // Pulling the image may take minutes: poll in the meantime
        plugin.instanceIsReady().catch(e => this.log.error(`Cannot start the container: ${errorText(e)}`));
        return true;
    }

    private schedulePoll(delay: number): void {
        if (this.stopping) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
        }
        this.pollTimer = this.setTimeout(() => {
            this.pollTimer = undefined;
            this.polling = true;
            this.poll()
                .catch(e => this.log.error(`Poll failed: ${errorText(e)}`))
                .finally(() => {
                    this.polling = false;
                    const soon = this.pollSoon;
                    this.pollSoon = 0;
                    this.schedulePoll(
                        soon || (this.reachable ? toNumber(this.config.pollInterval, 30) * 1000 : FAST_POLL),
                    );
                });
        }, delay);
    }

    /** Poll soon, e.g. after a change. Inside a running poll the next one is brought forward. */
    private requestPoll(delay: number): void {
        if (this.polling) {
            this.pollSoon = delay;
        } else {
            this.schedulePoll(delay);
        }
    }

    private async poll(): Promise<void> {
        const client = this.client;
        if (!client) {
            return;
        }
        if (this.dockerMode && this.containerRequested) {
            await this.updateContainerStatus();
        }

        let node: NodeInfo;
        try {
            node = await client.getNode();
        } catch (e) {
            await this.onUnreachable(e);
            return;
        }
        if (!this.reachable) {
            this.reachable = true;
            this.unreachableSince = 0;
            this.log.info(`Connected to the border router at ${client.baseUrl}`);
            await this.setState('info.connection', true, true);
            await this.setProblem('');
        }
        await this.updateNode(node);

        if (!this.coprocessorVersion) {
            try {
                this.coprocessorVersion = await client.getCoprocessorVersion();
                this.log.info(`Firmware of the stick: ${this.coprocessorVersion}`);
                await this.setStateChangedAsync('info.coprocessorVersion', this.coprocessorVersion, true);
            } catch (e) {
                this.log.debug(`Cannot read the firmware version: ${errorText(e)}`);
            }
        }

        let dataset: string | null;
        try {
            dataset = await client.getActiveDataset();
        } catch (e) {
            this.logErrorOnce(`Cannot read the dataset: ${errorText(e)}`);
            return;
        }
        if (dataset) {
            await this.onDataset(dataset, node);
        } else {
            await this.onNoDataset();
        }
    }

    private logErrorOnce(text: string): void {
        if (text !== this.lastError) {
            this.lastError = text;
            this.log.warn(text);
        }
    }

    private async onUnreachable(e: unknown): Promise<void> {
        if (this.reachable || !this.unreachableSince) {
            const wasConnected = this.reachable;
            this.reachable = false;
            this.unreachableSince = Date.now();
            this.coprocessorVersion = '';
            await this.setState('info.connection', false, true);
            const text = `The border router at ${this.client?.baseUrl} is not reachable: ${errorText(e)}`;
            if (wasConnected || !this.dockerMode) {
                this.log.warn(text);
            } else {
                // the container is still starting
                this.log.debug(text);
            }
        }
        const now = Date.now();
        if (
            this.dockerMode &&
            this.containerRequested &&
            now - this.unreachableSince >= DIAGNOSE_AFTER &&
            now - this.lastDiagnose >= DIAGNOSE_INTERVAL
        ) {
            this.lastDiagnose = now;
            await this.diagnoseContainer();
        }
    }

    private async updateContainerStatus(): Promise<{ names: string; status: string } | undefined> {
        const manager = this.getDockerPlugin()?.getDockerManager();
        if (!manager) {
            return undefined;
        }
        try {
            const container = (await manager.containerList(true)).find(c => c.names === this.containerName);
            await this.setStateChangedAsync('info.container', container?.status || 'not created', true);
            return container;
        } catch (e) {
            this.log.debug(`Cannot read the container status: ${errorText(e)}`);
            return undefined;
        }
    }

    /** Look into the log of the container to tell the user why the border router does not start */
    private async diagnoseContainer(): Promise<void> {
        const manager = this.getDockerPlugin()?.getDockerManager();
        if (!manager) {
            return;
        }
        const container = await this.updateContainerStatus();
        if (!container) {
            this.log.info(`The container ${this.containerName} does not exist yet. Is the image still being pulled?`);
            return;
        }
        let lines: string[] = [];
        try {
            lines = await manager.containerLogs(this.containerName, { tail: 300 });
        } catch (e) {
            this.log.debug(`Cannot read the container log: ${errorText(e)}`);
        }
        const problem = analyzeLog(lines);
        if (problem) {
            await this.setProblem(problem.text, problem.line);
        } else if (container.status !== 'running') {
            await this.setProblem(
                `The container ${this.containerName} is ${container.status}. See its log: docker logs ${this.containerName}`,
            );
        } else {
            await this.setProblem(
                `The REST API of otbr-agent does not answer. See the log of the container: docker logs ${this.containerName}`,
            );
        }
    }

    private async setProblem(text: string, logLine?: string): Promise<void> {
        if (text === this.lastProblem) {
            return;
        }
        if (text) {
            this.log.warn(logLine ? `${text} (log: ${logLine})` : text);
        } else if (this.lastProblem) {
            this.log.info('The border router works again');
        }
        this.lastProblem = text;
        await this.setState('info.problem', text, true);
    }

    private async updateNode(node: NodeInfo): Promise<void> {
        await this.setStateChangedAsync('thread.role', node.role, true);
        await this.setStateChangedAsync('thread.enabled', node.role !== 'disabled', true);
        await this.setStateChangedAsync('thread.rloc16', node.rloc16 ?? null, true);
        await this.setStateChangedAsync('thread.routers', node.routers ?? null, true);
        await this.setStateChangedAsync('thread.borderAgentId', node.borderAgentId ?? null, true);
    }

    private async onDataset(dataset: string, node: NodeInfo): Promise<void> {
        let info: DatasetInfo;
        try {
            info = parseDataset(dataset);
        } catch (e) {
            this.logErrorOnce(`Cannot decode the dataset: ${errorText(e)}`);
            return;
        }
        if (dataset !== this.dataset) {
            this.dataset = dataset;
            this.noDatasetLogged = false;
            this.log.info(
                `Thread network "${info.networkName}", channel ${info.channel}, PAN ID 0x${(info.panId ?? 0).toString(16).padStart(4, '0')}, extended PAN ID ${info.extPanId}`,
            );
            await this.setStateChangedAsync('thread.networkName', info.networkName ?? null, true);
            await this.setStateChangedAsync('thread.channel', info.channel ?? null, true);
            await this.setStateChangedAsync(
                'thread.panId',
                info.panId === undefined ? null : `0x${info.panId.toString(16).padStart(4, '0')}`,
                true,
            );
            await this.setStateChangedAsync('thread.extPanId', info.extPanId ?? null, true);
            await this.setStateChangedAsync('thread.meshLocalPrefix', info.meshLocalPrefix ?? null, true);
        }

        // A border router with a stored network starts it by itself; older builds wait for "enable". Only once
        // per start of the instance, so that a network stopped via thread.enabled stays stopped.
        if (!this.autoEnableDone) {
            this.autoEnableDone = true;
            if (node.role === 'disabled') {
                try {
                    await this.client!.setThreadEnabled(true);
                    this.log.info('Thread network started');
                } catch (e) {
                    this.log.warn(`Cannot start the Thread network: ${errorText(e)}`);
                }
            }
        }

        const matter = this.config.matterInstance;
        if (matter && dataset !== this.matterHandedOver && Date.now() - this.matterLastAttempt >= MATTER_RETRY) {
            this.matterLastAttempt = Date.now();
            try {
                this.log.info(await this.handOverToMatter(matter));
                this.matterHandedOver = dataset;
            } catch (e) {
                this.log.warn(`Cannot hand the Thread network to ${matter}: ${errorText(e)}`);
            }
        }
    }

    private async onNoDataset(): Promise<void> {
        this.dataset = null;
        if (this.networkTask) {
            return;
        }
        if (!this.config.autoCreateNetwork) {
            if (!this.noDatasetLogged) {
                this.noDatasetLogged = true;
                this.log.info(
                    'The border router has no Thread network yet. Create one or use an existing one in the settings (tab Thread network).',
                );
            }
            return;
        }
        try {
            await this.exclusive(() => this.setUpNetwork());
        } catch (e) {
            this.logErrorOnce(`Cannot set up the Thread network: ${errorText(e)}`);
        }
    }

    /** Run a change of the Thread network; a second change at the same time is refused */
    private async exclusive<T>(task: () => Promise<T>): Promise<T> {
        if (this.networkTask) {
            throw new Error('The Thread network is being changed already. Please wait a moment.');
        }
        const running = task();
        this.networkTask = running;
        try {
            return await running;
        } finally {
            this.networkTask = null;
        }
    }

    /**
     * The border router has no network: join the network that ioBroker.matter or another border router knows
     * already, otherwise create a new one.
     */
    private async setUpNetwork(): Promise<void> {
        if (this.config.joinExistingNetwork) {
            const { network, networks } = chooseNetworkToJoin(await this.findKnownNetworks());
            if (network) {
                this.log.info(`Using the known Thread network ${networkLabel(network)} instead of creating a new one`);
                await this.importNetwork(network.dataset, false);
                return;
            }
            if (networks.length > 1) {
                throw new Error(
                    `${networks.length} Thread networks are known: ${networks.map(networkLabel).join('; ')}. ` +
                        'Select the one to use in the settings (tab Thread network) or create a new one there.',
                );
            }
        }
        await this.createNetwork();
    }

    /** The Thread networks of the matter instances and of the other border-router instances */
    private async findKnownNetworks(): Promise<KnownNetwork[]> {
        const matter: MatterController[] = [];
        const borderRouters: OtherBorderRouter[] = [];
        for (const obj of await this.getInstances()) {
            const instance = obj._id.replace(/^system\.adapter\./, '');
            if (/^matter\.\d+$/.test(instance)) {
                const controller = await this.getForeignObjectAsync(`${instance}.controller`);
                if (controller?.native) {
                    matter.push({ instance, native: controller.native as MatterControllerNative });
                }
            } else if (/^border-router\.\d+$/.test(instance) && instance !== this.namespace) {
                if (!(await this.getForeignStateAsync(`system.adapter.${instance}.alive`))?.val) {
                    continue;
                }
                try {
                    const response = (await this.sendToAsync(instance, 'getDataset', {}, { timeout: 5000 })) as
                        { result?: { dataset?: string } } | undefined;
                    if (response?.result?.dataset) {
                        borderRouters.push({ instance, dataset: response.result.dataset });
                    }
                } catch (e) {
                    this.log.debug(`Cannot ask ${instance} for its Thread network: ${errorText(e)}`);
                }
            }
        }
        const fingerprint = (await this.getStateAsync('info.matterFingerprint'))?.val;
        return collectKnownNetworks(
            matter,
            borderRouters,
            this.namespace,
            typeof fingerprint === 'string' ? fingerprint : undefined,
        );
    }

    /**
     * Let the border router use an existing network.
     *
     * @param raw dataset as TLV hex
     * @param replace whether a different network of this border router may be replaced
     * @returns a text for the user
     */
    private async importNetwork(raw: string, replace: boolean): Promise<string> {
        const client = this.client;
        if (!client) {
            throw new Error('No border router configured');
        }
        const { dataset, info } = normalizeImportDataset(raw);
        const result = await client.importActiveDataset(dataset, replace);
        if (result === 'unchanged') {
            return `The border router uses the Thread network "${info.networkName}" already`;
        }
        this.autoEnableDone = true;
        this.requestPoll(2000);
        const zigbee = zigbeeChannels(await this.getInstances()).includes(info.channel!)
            ? ` Note: a Zigbee instance uses channel ${info.channel} too.`
            : '';
        const text = `${result === 'replaced' ? 'Replaced the Thread network by' : 'Joined the Thread network'} "${info.networkName}" (channel ${info.channel}, extended PAN ID ${info.extPanId}).${zigbee}`;
        this.log.info(text);
        return text;
    }

    /** Create a new Thread network with a random network key */
    private async createNetwork(
        networkName?: string,
        channel?: number,
    ): Promise<{ networkName: string; channel: number }> {
        const client = this.client;
        if (!client) {
            throw new Error('No border router configured');
        }
        const name = networkName || this.config.networkName || defaultNetworkName(randomBytes(2).toString('hex'));
        if (!isValidNetworkName(name)) {
            throw new Error(`The network name "${name}" is longer than 16 bytes`);
        }
        let ch = toNumber(channel || this.config.channel, 0);
        if (!ch) {
            ch = chooseChannel(zigbeeChannels(await this.getInstances()));
        }
        if (!isValidChannel(ch)) {
            throw new Error(`Invalid channel ${ch}, allowed are 11 to 26`);
        }
        if (!(await client.createActiveDataset({ networkName: name, channel: ch }))) {
            throw new Error('The border router has a Thread network already');
        }
        this.log.info(`Created the Thread network "${name}" on channel ${ch}`);
        await client.setThreadEnabled(true);
        this.autoEnableDone = true;
        this.requestPoll(2000);
        return { networkName: name, channel: ch };
    }

    /**
     * Put the network name and dataset into the controller configuration of ioBroker.matter, so that it can
     * commission Thread devices into this network.
     *
     * @returns a text for the user
     */
    private async handOverToMatter(instance: string): Promise<string> {
        if (!/^matter\.\d+$/.test(instance)) {
            throw new Error(`"${instance}" is not an instance of ioBroker.matter`);
        }
        const dataset = this.dataset;
        if (!dataset) {
            throw new Error('The border router has no Thread network yet');
        }
        const objId = `${instance}.controller`;
        const obj = await this.getForeignObjectAsync(objId);
        if (!obj) {
            throw new Error(`${instance} has no controller configuration yet. Enable the controller there first.`);
        }
        const networkName = parseDataset(dataset).networkName || 'Thread';
        const fingerprint = (await this.getStateAsync('info.matterFingerprint'))?.val;
        const merged = mergeThreadCredentials(
            (obj.native || {}) as MatterControllerNative,
            networkName,
            dataset,
            this.namespace,
            ds => !!fingerprint && datasetFingerprint(ds) === fingerprint,
        );
        if (merged.changed) {
            const alive = await this.getForeignStateAsync(`system.adapter.${instance}.alive`);
            if (alive?.val) {
                const response = (await this.sendToAsync(
                    instance,
                    'updateControllerSettings',
                    JSON.stringify(merged.native),
                    { timeout: 20_000 },
                )) as { error?: string } | undefined;
                if (response?.error) {
                    throw new Error(String(response.error));
                }
            } else {
                // matter reads the object when it starts
                await this.extendForeignObjectAsync(objId, { native: merged.native });
            }
        }
        await this.setStateChangedAsync('info.matterFingerprint', datasetFingerprint(dataset), true);
        if (!merged.changed) {
            return `${instance} knows the Thread network "${networkName}" already`;
        }
        return merged.target === 'default'
            ? `Thread network "${networkName}" handed to ${instance} as its default Thread network`
            : `Thread network "${networkName}" handed to ${instance} as additional Thread network "${this.namespace}" (the default network there was entered by hand and is kept)`;
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || id !== `${this.namespace}.thread.enabled` || !this.client) {
            return;
        }
        try {
            await this.client.setThreadEnabled(!!state.val);
            this.log.info(`Thread network ${state.val ? 'started' : 'stopped'}`);
            await this.setState('thread.enabled', !!state.val, true);
            this.requestPoll(2000);
        } catch (e) {
            this.log.warn(`Cannot ${state.val ? 'start' : 'stop'} the Thread network: ${errorText(e)}`);
        }
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command) {
            return;
        }
        const message = (obj.message && typeof obj.message === 'object' ? obj.message : {}) as Record<string, unknown>;
        const reply = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };

        try {
            switch (obj.command) {
                case 'listSerialPorts':
                    reply(await listSerialPorts());
                    break;

                case 'listInterfaces':
                    reply(listInterfaces());
                    break;

                case 'checkPort': {
                    const port = textOf(message.serialPort ?? this.config.serialPort);
                    const problem = await this.checkSerialPort(port);
                    const stick = describeStick(port);
                    if (problem) {
                        reply({ error: problem });
                    } else {
                        const settings =
                            stick?.baudRate !== undefined
                                ? ` Usual settings of its OpenThread firmware: ${stick.baudRate} baud, flow control ${stick.flowControl ? 'on' : 'off'}.`
                                : '';
                        reply({
                            result: `${stick ? `${stick.name}. ` : ''}${stick?.warning || 'The port is free.'}${settings}`,
                        });
                    }
                    break;
                }

                case 'getDataset': {
                    if (!this.dataset) {
                        reply({ error: 'The border router has no Thread network yet' });
                    } else {
                        reply({ result: { ...parseDataset(this.dataset), dataset: this.dataset } });
                    }
                    break;
                }

                case 'createNetwork': {
                    if (this.dataset) {
                        reply({ error: 'The border router has a Thread network already' });
                        break;
                    }
                    if (!this.reachable) {
                        reply({ error: 'The border router is not reachable' });
                        break;
                    }
                    const created = await this.exclusive(() =>
                        this.createNetwork(
                            typeof message.networkName === 'string' ? message.networkName.trim() : undefined,
                            toNumber(message.channel as number, 0) || undefined,
                        ),
                    );
                    reply({ result: `Thread network "${created.networkName}" created on channel ${created.channel}` });
                    break;
                }

                case 'listKnownNetworks': {
                    // answer of selectSendTo: the network key stays in the adapter
                    const networks = await this.findKnownNetworks();
                    reply(networks.map(network => ({ value: network.key, label: networkLabel(network) })));
                    break;
                }

                case 'importDataset': {
                    if (!this.reachable) {
                        reply({ error: 'The border router is not reachable' });
                        break;
                    }
                    // a checkbox that was never touched comes as "undefined"
                    const replace = message.replace === true || message.replace === 'true';
                    const source = textOf(message.source);
                    const input = textOf(message.dataset);
                    let dataset: string;
                    if (source) {
                        const network = (await this.findKnownNetworks()).find(n => n.key === source);
                        if (!network) {
                            reply({ error: `The Thread network of ${source} is not known (any more)` });
                            break;
                        }
                        dataset = network.dataset;
                    } else if (/^https?:\/\//i.test(input)) {
                        const other = await new OtbrClient(input).getActiveDataset();
                        if (!other) {
                            reply({ error: `The border router at ${input} has no Thread network` });
                            break;
                        }
                        dataset = other;
                    } else if (input) {
                        dataset = input;
                    } else {
                        reply({ error: 'Enter a dataset or select a known Thread network' });
                        break;
                    }
                    reply({ result: await this.exclusive(() => this.importNetwork(dataset, replace)) });
                    break;
                }

                case 'handOverToMatter': {
                    const instance = textOf(message.instance) || this.config.matterInstance || '';
                    if (!instance) {
                        reply({ error: 'Select an instance of ioBroker.matter' });
                        break;
                    }
                    const text = await this.handOverToMatter(instance);
                    this.matterHandedOver = this.dataset || '';
                    reply({ result: text });
                    break;
                }

                default:
                    this.log.warn(`Unknown command: ${obj.command}`);
                    reply({ error: `Unknown command: ${obj.command}` });
            }
        } catch (e) {
            reply({ error: errorText(e) });
        }
    }

    private onUnload(callback: () => void): void {
        this.stopping = true;
        try {
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BorderRouterAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new BorderRouterAdapter())();
}
