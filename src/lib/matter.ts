import { createHash } from 'node:crypto';

/**
 * Hand the Thread credentials to ioBroker.matter. Its controller keeps them in the object `matter.X.controller`
 * (native: `threadNetworkName`, `threadOperationalDataSet` and the list `additionalThreadCredentials`) and takes
 * a new configuration with the message `updateControllerSettings` (a JSON string).
 */

export interface ThreadCredentialEntry {
    id: string;
    networkName: string;
    operationalDataset: string;
}

export interface MatterControllerNative {
    threadNetworkName?: string;
    threadOperationalDataSet?: string;
    additionalThreadCredentials?: ThreadCredentialEntry[];
    [key: string]: unknown;
}

export interface MergeResult {
    native: MatterControllerNative;
    changed: boolean;
    /** `default`: the default Thread network of the controller; `additional`: an own entry of the list */
    target: 'default' | 'additional';
}

function sameDataset(a: string | undefined, b: string): boolean {
    return !!a && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * SHA-256 of a dataset. Stored instead of the dataset itself to recognize a dataset handed over before: the
 * dataset contains the network key, the fingerprint does not reveal it.
 */
export function datasetFingerprint(dataset: string): string {
    return createHash('sha256').update(dataset.trim().toUpperCase()).digest('hex');
}

/**
 * Put the dataset into the controller configuration of ioBroker.matter.
 *
 * The default network of the controller is only written if it is empty or was written by this adapter
 * before. A network that the user entered there - e.g. of another border router - is kept, the own network
 * goes into `additionalThreadCredentials` under the ID of this instance then.
 *
 * @param current native of `matter.X.controller`
 * @param networkName name of the Thread network
 * @param dataset active operational dataset, TLV hex
 * @param id ID of the entry in `additionalThreadCredentials`, the namespace of this instance
 * @param handedOverBefore tells whether a dataset was handed over by this instance before, so that a
 *  recreated network replaces its predecessor
 */
export function mergeThreadCredentials(
    current: MatterControllerNative,
    networkName: string,
    dataset: string,
    id: string,
    handedOverBefore: (dataset: string) => boolean = () => false,
): MergeResult {
    const native: MatterControllerNative = { ...current };
    const defaultIsOurs =
        !current.threadOperationalDataSet ||
        sameDataset(current.threadOperationalDataSet, dataset) ||
        handedOverBefore(current.threadOperationalDataSet);

    if (defaultIsOurs) {
        const changed =
            current.threadNetworkName !== networkName || !sameDataset(current.threadOperationalDataSet, dataset);
        native.threadNetworkName = networkName;
        native.threadOperationalDataSet = dataset;
        return { native, changed, target: 'default' };
    }

    const list = [...(current.additionalThreadCredentials || [])];
    const index = list.findIndex(entry => entry.id === id);
    const entry: ThreadCredentialEntry = { id, networkName, operationalDataset: dataset };
    let changed = true;
    if (index === -1) {
        list.push(entry);
    } else {
        changed = list[index].networkName !== networkName || !sameDataset(list[index].operationalDataset, dataset);
        list[index] = entry;
    }
    native.additionalThreadCredentials = list;
    return { native, changed, target: 'additional' };
}
