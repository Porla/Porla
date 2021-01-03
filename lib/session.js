const _ = require('lodash');
const { EventEmitter } = require('events');
const logger = require('./logger');
const lt = require('@porla/libtorrent');
const { session_stats_metrics } = lt;
const Torrent = require('./torrent');

const metrics = session_stats_metrics().reduce((acc, curr) => {
    acc[curr.name] = {
        index: curr.value_index,
        type: curr.type
    };
    return acc;
}, {});

const emitter = new EventEmitter();
const internalEmitter = new EventEmitter();
const mutedTorrents = [];
const timers = {};
const torrents = new Map();
const initialMetadata = {};

let exiting = false;
let loadOptions = null;
let session = null;

async function saveTorrent(db, status) {
    const ct = new lt.create_torrent(status.torrent_file);
    const buffer = ct.generate_buf();

    await db.run(
        `INSERT INTO torrents (info_hash, queue_position) VALUES (?, ?);`,
        [ status.info_hash, status.queue_position ]);

    await db.run(
        `INSERT INTO torrent_files (info_hash, data) VALUES (?, ?);`,
        [ status.info_hash, buffer ]);

    logger.debug('Saved torrent file (%d bytes)', buffer.length)
}

const init = async (db, options) => {
    options = options || {};

    let params = null;

    try {
        const res = await db.get('SELECT data, timestamp FROM session_params ORDER BY timestamp DESC LIMIT 1');

        if (typeof res === 'undefined') {
            params = new lt.session_params();
        } else {
            params = lt.read_session_params(res.data, lt.save_state_flags.save_dht_state);
            logger.info('Loaded session params (%d bytes)', res.data.length);
        }
    } catch (err) {
        params = new lt.session_params();
    }

    params.settings.set_int('alert_mask', lt.alert.all_categories);
    params.settings.set_str('dht_bootstrap_nodes', 'router.bittorrent.com:6881,router.utorrent.com:6881,dht.transmissionbt.com:6881,dht.aelitis.com:6881');
    params.settings.set_bool('enable_dht', true);
    params.settings.set_bool('enable_lsd', true);
    params.settings.set_int('in_enc_policy', 1);
    params.settings.set_int('out_enc_policy', 1);
    params.settings.set_str('peer_fingerprint', lt.generate_fingerprint('PO', 0, 0, 1));
    params.settings.set_int('stop_tracker_timeout', 1);
    params.settings.set_str('user_agent', 'Porla/alpha libtorrent/2.0');

    // Custom DHT bootstrap nodes
    if (options.dht && Array.isArray(options.dht.bootstrapNodes)) {
        const nodes = options.dht.bootstrapNodes
            .map(val => `${val[0]}:${val[1]}`)
            .join(',');

        params.settings.set_str('dht_bootstrap_nodes', nodes);
    }

    if (options.dht && typeof options.dht.enabled === 'boolean') {
        params.settings.set_bool('enable_dht', options.dht.enabled);
    }

    // Listen interfaces
    if (Array.isArray(options.listenInterfaces)) {
        const ifaces = options.listenInterfaces
            .map(val => `${val[0]}:${val[1]}`)
            .join(',');

        params.settings.set_str('listen_interfaces', ifaces);
        params.settings.set_str('outgoing_interfaces', ifaces);
    }

    // Require encryption, perhaps.
    if (typeof options.requireEncryption === 'boolean') {
        if (options.requireEncryption) {
            params.settings.set_int('in_enc_policy', 0); // forced
            params.settings.set_int('out_enc_policy', 0); // forced
        }
    }

    // Proxy
    if ('proxy' in options) {
        const { proxy } = options;

        params.settings.set_int('proxy_type', proxy.type);
        params.settings.set_str('proxy_hostname', proxy.host);
        params.settings.set_int('proxy_port', proxy.port);

        if (proxy.username) {
            params.settings.set_str('proxy_username', proxy.username);
        }

        if (proxy.password) {
            params.settings.set_str('proxy_password', proxy.password);
        }

        if (typeof proxy.force === 'boolean' && proxy.force) {
            params.settings.set_bool('proxy_hostnames', true);
            params.settings.set_bool('proxy_peer_connections', true);
            params.settings.set_bool('proxy_tracker_connections', true);
        }

        logger.debug('Setting up session proxy');
    }

    session = new lt.session(params);
}

const loadTorrents = async (db) => {
    let actual = 0;

    function add (err, { info_hash, file_data, resume_data }) {
        const params = resume_data !== null
            ? lt.read_resume_data(resume_data)
            : new lt.add_torrent_params();

        if (file_data) {
            params.ti = new lt.torrent_info(file_data);
        }

        // Mute this torrent - i.e no add notifications
        mutedTorrents.push(info_hash);

        session.async_add_torrent(params);
        actual += 1;
    }

    const { cnt } = await db.get('SELECT COUNT(*) AS cnt FROM torrents');
    logger.debug('Loading %d torrent(s) from database', cnt);

    await db.each(`SELECT t.info_hash, t.resume_data, tf.data as file_data
                   FROM torrents t
                   LEFT JOIN torrent_files tf on t.info_hash = tf.info_hash
                   ORDER BY t.queue_position ASC`,
                   [],
                   add);

    logger.info('Loaded %d torrent(s) from database', actual);
}

const readAlerts = async (db) => {
    do {
        const foundAlerts = await waitForAlerts(100);

        if (!foundAlerts) {
            continue;
        }

        const alerts = session.pop_alerts();

        for (const alert of alerts) {
            switch(alert.what) {
                case 'add_torrent':
                    // TODO: check error

                    const status = alert.handle.status();
                    let muted = false;

                    logger.debug('Torrent "%s" added', status.info_hash);

                    // Check if this torrent is a muted torrent - i.e it
                    // was added as a part of the load function.
                    if (mutedTorrents.includes(status.info_hash)) {
                        const idx = mutedTorrents.indexOf(status.info_hash);
                        mutedTorrents.splice(idx, 1);
                        muted = true;
                    } else if(status.has_metadata) {
                        await saveTorrent(db, status);
                    }

                    const torrent = new Torrent(alert.handle);

                    if (torrent.infoHash in initialMetadata) {
                        torrent._metadata = { ...initialMetadata[torrent.infoHash] };
                        delete initialMetadata[torrent.infoHash];
                    }

                    if (!torrents.has(status.info_hash)) {
                        torrents.set(status.info_hash, torrent);
                    }

                    if (!muted) {
                        emitter.emit('torrent.added', { torrent });
                    }

                    break;

                case 'metadata_received':
                    await saveTorrent(db, alert.handle.status());
                    break;

                case 'session_stats':
                    const metricKeys = Object.keys(metrics);
                    const sessionStats = metricKeys.reduce((acc, curr, idx) => {
                        const metric = metricKeys[idx];
                        acc[metric] = alert.counters[metrics[metric].index];
                        return acc;
                    }, {});

                    emitter.emit('session.statistics', { stats: sessionStats });
                    break;

                case 'state_update':
                    const torrentsStats = alert.status.reduce((acc, curr) => {
                        acc.downloadPayloadRate += curr.download_payload_rate;
                        acc.uploadPayloadRate += curr.upload_payload_rate;
                        return acc;
                    }, {
                        downloadPayloadRate: 0,
                        uploadPayloadRate: 0
                    });

                    emitter.emit('torrents.statistics', { stats: torrentsStats });

                    const updatedTorrents = [];

                    for (const status of alert.status) {
                        const updatedTorrent = torrents.get(status.info_hash);
                        updatedTorrent._status = status;

                        updatedTorrents.push(updatedTorrent);
                    }

                    if (updatedTorrents.length > 0) {
                        emitter.emit('torrents.updated', { torrents: updatedTorrents });
                    }
                    break;

                case 'storage_moved':
                    const smTorrent = torrents.get(alert.handle.info_hash());
                    smTorrent._status = alert.handle.status();
                    smTorrent.emit('storage_moved');
                    break;

                case 'storage_moved_failed':
                    const smfTorrent = torrents.get(alert.handle.info_hash());
                    smfTorrent.emit('storage_moved_failed', { error: alert.error });
                    break;

                case 'torrent_finished':
                    const finishedTorrent = torrents.get(alert.handle.info_hash());
                    finishedTorrent._status = alert.handle.status();

                    if (finishedTorrent._status.total_payload_download > 0) {
                        emitter.emit('torrent.finished', { torrent: finishedTorrent });
                    }
                    break;

                case 'torrent_paused':
                    const pausedTorrent = torrents.get(alert.handle.info_hash());
                    pausedTorrent.emit('paused');
                    emitter.emit('torrent.paused', { torrent: pausedTorrent });
                    break;

                case 'torrent_removed':
                    const removedTorrent = torrents.get(alert.info_hash);
                    removedTorrent.emit('removed');
                    torrents.delete(alert.info_hash);
                    emitter.emit('torrent.removed', { torrent: { infoHash: alert.info_hash } });

                    // Remove torrent and dat file (if any)
                    await db.run('DELETE FROM torrent_files WHERE info_hash = ?', [ alert.info_hash ]);
                    await db.run('DELETE FROM torrents      WHERE info_hash = ?', [ alert.info_hash ]);

                    break;
            }
        }
    } while (!exiting);

    internalEmitter.emit('readAlerts.finished');
}

const unload = (db) => {
    return new Promise((resolve, reject) => {
        logger.debug('Starting to unload session');

        internalEmitter.once('readAlerts.finished', async () => {
            logger.debug('Saving state');

            clearInterval(timers.postUpdates);

            const sessionParams = lt.write_session_params_buf(
                session.session_state(),
                lt.save_state_flags.save_dht_state);

            await db.run(
                `INSERT INTO session_params (data, timestamp)
                 VALUES (?, strftime('%s'));`,
                 [ sessionParams ]);

            logger.info('Session params saved (%d bytes)', sessionParams.length);

            session.pause();

            let numOutstandingResumeData = 0;
            const tempStatus = session.get_torrent_status();

            for (const st of tempStatus) {
                if (!st.handle.is_valid() || !st.has_metadata || !st.need_save_resume) {
                    continue;
                }

                st.handle.save_resume_data();
                numOutstandingResumeData += 1;
            }

            logger.info('Saving resume data for %d torrents', numOutstandingResumeData);

            while (numOutstandingResumeData > 0) {
                const foundAlerts = await waitForAlerts(1000);
                if (!foundAlerts) { continue; }

                const alerts = session.pop_alerts();

                for (const alert of alerts) {
                    if (alert.what === 'torrent_paused') {
                        continue;
                    }

                    if (alert.what === 'save_resume_data_failed') {
                        numOutstandingResumeData -= 1;
                        continue;
                    }

                    if (alert.what !== 'save_resume_data') {
                        continue;
                    }

                    numOutstandingResumeData -= 1;

                    const status = alert.handle.status();
                    const resume = lt.write_resume_data_buf(alert.params);

                    await db.run(
                        `UPDATE torrents SET queue_position = ?, resume_data = ? WHERE info_hash = ?`,
                        [ status.queue_position, resume, alert.handle.info_hash() ]);
                }
            }

            return resolve();
        });

        exiting = true;
    });
}

const waitForAlerts = (timeout) => {
    return new Promise((resolve, reject) => {
        session.wait_for_alert(timeout, (err, result) => {
            if (err) {
                return reject(err);
            }

            return resolve(result);
        });
    });
}

function parseOptions(params, options) {
    params.save_path = options.savePath || loadOptions.savePath || '.';

    // add initial metadata, such as tags
    const meta = {};

    if ('tags' in options) {
        if (typeof options.tags === 'string') {
            options.tags = [ options.tags ];
        }

        meta['tags'] = options.tags;
    }

    initialMetadata[params.info_hash] = meta;
}

module.exports = {
    addMagnetLink: (magnetLink, options) => {
        options = options || {};

        const params     = lt.parse_magnet_uri(magnetLink);

        parseOptions(params, options);

        logger.debug(
            'Adding magnet link "%s" to save path "%s"',
            magnetLink,
            params.save_path);

        session.async_add_torrent(params);
    },
    addTorrent: (fileOrBuffer, options) => {
        options = options || {};

        const params = new lt.add_torrent_params();
        params.ti    = new lt.torrent_info(fileOrBuffer);

        parseOptions(params, options);

        logger.debug(
            'Adding torrent "%s" to save path "%s"',
            params.ti.info_hash(),
            params.save_path);

        session.async_add_torrent(params);
    },
    init: async (db, options) => {
        await init(db, options);
    },
    load: async (db, options) => {
        loadOptions = options;

        await loadTorrents(db);

        readAlerts(db);

        timers.postUpdates = setInterval(() => {
            session.post_dht_stats();
            session.post_session_stats();
            session.post_torrent_updates();
        }, 1000);
    },

    // returns the native libtorrent session, for advanced usage only
    native: () => session,

    // session is an eventemitter?
    off: emitter.off,
    on: emitter.on.bind(emitter),
    once: emitter.once,

    removeTorrent(torrentOrInfoHash) {
        if (typeof torrentOrInfoHash === 'string' && torrents.has(torrentOrInfoHash)) {
            logger.info('Removing torrent %s', torrentOrInfoHash);
            session.remove_torrent(torrents.get(torrentOrInfoHash)._handle);
        } else if (torrentOrInfoHash instanceof Torrent) {
            logger.info('Removing torrent %s', torrentOrInfoHash.infoHash);
            session.remove_torrent(torrentOrInfoHash._handle);
        } else {
            logger.warn('Unknown torrent or info hash: %s', torrentOrInfoHash);
        }
    },

    torrents: () => {
        return torrents.values();
    },
    unload: unload
}
