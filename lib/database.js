const sqlite3 = require('sqlite3');

class Database {
    constructor(filename) {
        this._db = new sqlite3.Database(filename);
    }

    all (sql, params) {
        return new Promise((resolve, reject) => {
            this._db.all(sql, params, function (err, row) {
                if (err) return reject(err);
                resolve(row);
            });
        });
    }

    each (sql, params, callback) {
        return new Promise((resolve, reject) => {
            this._db.each(sql, params, callback, function (err, result) {
                if (err) return reject(err);
                resolve(result);
            });
        });
    }

    get (sql, params) {
        return new Promise((resolve, reject) => {
            this._db.get(sql, params, function (err, row) {
                if (err) return reject(err);
                resolve(row);
            });
        });
    }

    run (sql, params) {
        return new Promise((resolve, reject) => {
            this._db.run(sql, params || [], function (err) {
                if (err) return reject(err);
                resolve();
            });
        });
    }
}

module.exports = {
    Database
};
