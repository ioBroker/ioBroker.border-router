import { normalizeImportDataset, type DatasetInfo } from './dataset';
import { datasetFingerprint, type MatterControllerNative } from './matter';

/**
 * Thread networks that this installation knows already: the networks in the controller configuration of
 * ioBroker.matter (e.g. of Home Assistant or Apple, entered there by hand, or handed over by this adapter) and
 * the networks of other border-router instances. A new border router joins one of them instead of creating a
 * network of its own: Matter devices in one Thread network can then use every border router.
 */

export interface KnownNetwork {
    /** to select it: `matter.0`, `matter.0/<id of the entry>` or `border-router.1` */
    key: string;
    /** where it was found, for the user */
    source: string;
    /** upper case hex */
    dataset: string;
    info: DatasetInfo;
    /** handed over to ioBroker.matter by this instance before, i.e. its own former network */
    own: boolean;
}

export interface MatterController {
    /** e.g. `matter.0` */
    instance: string;
    native: MatterControllerNative;
}

export interface OtherBorderRouter {
    /** e.g. `border-router.1` */
    instance: string;
    dataset: string;
}

/**
 * Collect the networks; incomplete or broken datasets are skipped.
 *
 * @param matter the controller configurations of the matter instances
 * @param borderRouters the datasets of the other border-router instances
 * @param ownId namespace of this instance, the ID of its entry in `additionalThreadCredentials`
 * @param ownFingerprint `info.matterFingerprint`: fingerprint of the dataset this instance handed over last
 */
export function collectKnownNetworks(
    matter: MatterController[],
    borderRouters: OtherBorderRouter[],
    ownId: string,
    ownFingerprint?: string,
): KnownNetwork[] {
    const list: KnownNetwork[] = [];
    const add = (key: string, source: string, raw: string | undefined, ownEntry: boolean): void => {
        if (!raw) {
            return;
        }
        let checked: ReturnType<typeof normalizeImportDataset>;
        try {
            checked = normalizeImportDataset(raw);
        } catch {
            return;
        }
        const own = ownEntry || (!!ownFingerprint && datasetFingerprint(checked.dataset) === ownFingerprint);
        list.push({ key, source, dataset: checked.dataset, info: checked.info, own });
    };

    for (const router of borderRouters) {
        add(router.instance, `border router ${router.instance}`, router.dataset, false);
    }
    for (const { instance, native } of matter) {
        add(instance, `default Thread network of ${instance}`, native.threadOperationalDataSet, false);
        for (const entry of native.additionalThreadCredentials || []) {
            add(
                `${instance}/${entry.id}`,
                `Thread network "${entry.id}" of ${instance}`,
                entry.operationalDataset,
                entry.id === ownId,
            );
        }
    }
    return list;
}

/**
 * One entry per network (extended PAN ID), the most recent dataset of it (highest active timestamp). The
 * same network is often known several times: by a border router and by matter.
 */
function perNetwork(list: KnownNetwork[]): KnownNetwork[] {
    const networks = new Map<string, KnownNetwork>();
    for (const network of list) {
        const id = network.info.extPanId || network.dataset;
        const known = networks.get(id);
        if (!known || (network.info.activeTimestamp ?? 0) > (known.info.activeTimestamp ?? 0)) {
            networks.set(id, network);
        }
    }
    return [...networks.values()];
}

/**
 * Choose the network that a border router without network joins: its own former network, otherwise the only
 * known one. With several known networks nothing is chosen - the user has to decide.
 *
 * @param list the known networks
 * @returns the network to join, and the networks to choose from if there is no clear choice
 */
export function chooseNetworkToJoin(list: KnownNetwork[]): { network?: KnownNetwork; networks: KnownNetwork[] } {
    const own = perNetwork(list.filter(network => network.own));
    if (own.length === 1) {
        return { network: own[0], networks: own };
    }
    const all = perNetwork(list);
    return all.length === 1 ? { network: all[0], networks: all } : { networks: all };
}

/** Text for the selection in the settings, without the network key */
export function networkLabel(network: KnownNetwork): string {
    const own = network.own ? ', created by this instance' : '';
    return `"${network.info.networkName}" (channel ${network.info.channel}) - ${network.source}${own}`;
}
