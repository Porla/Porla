const fs = require('fs/promises');
const path = require('path');

const logger = require('./logger');

async function migrationExists(db, migration) {
    const res = await db.get('SELECT COUNT(*) as cnt FROM porla_migrations WHERE name = ?', [ migration ]);
    return res.cnt !== 0;
}

async function applyMigrations(db) {
    const migrationsPath = path.join(__dirname, '..', 'migrations');
    const migrations = await fs.readdir(migrationsPath);

    logger.info('Running %d migration(s) from %s', migrations.length, migrationsPath);

    for (const file of migrations) {
        if (await migrationExists(db, file)) {
            logger.debug('Migration %s already exists. Skipping...', file);
            continue;
        }

        const migrationFile = path.join(migrationsPath, file);
        const migrationData = await fs.readFile(migrationFile, { encoding: 'utf-8' });

        logger.debug('Applying database migration %s', file);

        try {
            await db.run(migrationData);
            await db.run('INSERT INTO porla_migrations (name) VALUES (?)', [ file ]);
        }
        catch (err) {
            logger.error('Failed to apply migration %s: %s', file, err);
        }

        logger.info('Applied migration %s', file);
    }
}

async function createMigrationsTable(db) {
    logger.debug('Creating migrations table');

    try {
        await db.run('CREATE TABLE IF NOT EXISTS porla_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);');
    }
    catch (err) {
        logger.error('Failed to create migrations table: %s', err);
        throw err;
    }
}

async function migrate(db) {
    await createMigrationsTable(db);
    await applyMigrations(db);
}

module.exports = migrate;
