"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectKnownNetworks = collectKnownNetworks;
exports.chooseNetworkToJoin = chooseNetworkToJoin;
exports.networkLabel = networkLabel;
const dataset_1 = require("./dataset");
const matter_1 = require("./matter");
/**
 * Collect the networks; incomplete or broken datasets are skipped.
 *
 * @param matter the controller configurations of the matter instances
 * @param borderRouters the datasets of the other border-router instances
 * @param ownId namespace of this instance, the ID of its entry in `additionalThreadCredentials`
 * @param ownFingerprint `info.matterFingerprint`: fingerprint of the dataset this instance handed over last
 */
function collectKnownNetworks(matter, borderRouters, ownId, ownFingerprint) {
    const list = [];
    const add = (key, source, raw, ownEntry) => {
        if (!raw) {
            return;
        }
        let checked;
        try {
            checked = (0, dataset_1.normalizeImportDataset)(raw);
        }
        catch {
            return;
        }
        const own = ownEntry || (!!ownFingerprint && (0, matter_1.datasetFingerprint)(checked.dataset) === ownFingerprint);
        list.push({ key, source, dataset: checked.dataset, info: checked.info, own });
    };
    for (const router of borderRouters) {
        add(router.instance, `border router ${router.instance}`, router.dataset, false);
    }
    for (const { instance, native } of matter) {
        add(instance, `default Thread network of ${instance}`, native.threadOperationalDataSet, false);
        for (const entry of native.additionalThreadCredentials || []) {
            add(`${instance}/${entry.id}`, `Thread network "${entry.id}" of ${instance}`, entry.operationalDataset, entry.id === ownId);
        }
    }
    return list;
}
/**
 * One entry per network (extended PAN ID), the most recent dataset of it (highest active timestamp). The
 * same network is often known several times: by a border router and by matter.
 */
function perNetwork(list) {
    const networks = new Map();
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
function chooseNetworkToJoin(list) {
    const own = perNetwork(list.filter(network => network.own));
    if (own.length === 1) {
        return { network: own[0], networks: own };
    }
    const all = perNetwork(list);
    return all.length === 1 ? { network: all[0], networks: all } : { networks: all };
}
/** Text for the selection in the settings, without the network key */
function networkLabel(network) {
    const own = network.own ? ', created by this instance' : '';
    return `"${network.info.networkName}" (channel ${network.info.channel}) - ${network.source}${own}`;
}
//# sourceMappingURL=networks.js.map