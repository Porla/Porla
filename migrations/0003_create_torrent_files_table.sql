CREATE TABLE torrent_files (
    info_hash TEXT  PRIMARY KEY,
    data       BLOB NOT NULL,

    FOREIGN KEY(info_hash) REFERENCES torrents(info_hash)
);
