CREATE TABLE torrents (
    info_hash      TEXT    PRIMARY KEY,
    queue_position INTEGER NOT NULL,
    resume_data    BLOB
);
