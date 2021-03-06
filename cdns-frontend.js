/*jslint node: true */
"use strict";

// Dependencies
var cluster = require('cluster'),
    net = require('net'),
    async = require('async'),
    os = require('os'),

    localConfig = require('./libs/localConfig'),
    database = require('./libs/database')(localConfig.dbUrl, localConfig.dbName),
    loggers = require('./libs/logger'),
    tokenValidator = require('./libs/tokenValidator'),

    HttpServer = require('./libs/servers/HttpServer'),
    CDNSelector = require('./libs/CDNSelector'),
    LoadBalancer = require('./libs/LoadBalancer');

function checkPort(port, callback) {
    var server = net.createServer(),
        portAvailable = false;

    server.listen(port);
    server.on('listening', function () {
        portAvailable = true;
        server.close();
    });
    server.on('error', function (err) {
        callback(err, false);
    });
    server.on('close', function () {
        callback(null, true);
    });
}

function errorExit(err) {
    loggers.errorlog.error(err, err.stack);
    loggers.errorlog.error('Cannot start application. Please resolve all errors and try again');
    process.exit(1);
}

function startWorker(startupCompleteCallback) {
    var distribDao,
        cdnDao,
        cdnSelector,
        db,
        httpServer,
        loadBalancer;

    async.series([
        function connectToDatabase (next) {
            database.connect(function (err, database) {
                db = database;
                next(err);
            });
        },
        function loadDistributionConfig (next) {
            // Pre-load all distribution config
            distribDao = require('./libs/dao/DistributionDao')(db);
            distribDao.once('ready', next);
            distribDao.once('error', next);
        },
        function loadCDNs (next) {
            // Pre-load all CDN config
            cdnDao = require('./libs/dao/CDNDao')(db, distribDao);
            cdnDao.once('ready', next);
            cdnDao.once('error', next);
        }
    ], function (err, results) {
        if (!err) {
            loadBalancer = new LoadBalancer(localConfig.loadBalancePeriod);
            cdnSelector = new CDNSelector(distribDao, cdnDao, loadBalancer);

            httpServer = new HttpServer(localConfig.port, cdnSelector, loggers.accesslog, tokenValidator);
            httpServer.on('ready', function () {
                var uid = parseInt(process.env.SUDO_UID);
                if (uid) {
                    process.setuid(uid);
                }
                loggers.errorlog.info('Worker process ' + process.pid + ' started');
                if (startupCompleteCallback) {
                    startupCompleteCallback(null, httpServer);
                }
            });
            httpServer.on('redirection', function (cdn, distrib) {
                // Tell the load balancer whenever a CDN is used.
                loadBalancer.notifyCdnUsage(cdn, distrib);
            });
            httpServer.start();
        } else {
            if (startupCompleteCallback) {
                startupCompleteCallback(err);
            }
            errorExit(err);
        }
    });
}

function startMaster(startupCompleteCallback) {

    // Startup checks and pre-loading data
    if (cluster.isMaster) {
        // Master process
        async.series([
            function (callback) {
                // Check that we can bind to the port
                checkPort(localConfig.port, function (err, isAvailable) {
                    if (isAvailable) {
                        loggers.errorlog.info('Listening on port ' + localConfig.port);
                        callback();
                    } else {
                        callback(new Error('Cannot bind to port ' + localConfig.port + '. Is it already in use?', err));
                    }
                });
            },
            function (callback) {
                // Check that we can connect to the database, and
                // create the database if necessary
                database.connect(callback);
            }

        ], function (err, results) {
            if (startupCompleteCallback) {
                startupCompleteCallback(err);
            }

            if (err) {
                errorExit(err);
            } else {
                if (!process.env.CDNS_MANUAL_START) {
                    // Launch worker processes
                    var numCPUs = localConfig.workers || os.cpus().length;

                    loggers.errorlog.info('Starting cluster of ' + numCPUs + ' child processes.');

                    for (var i = 0; i < numCPUs; i += 1) {
                        cluster.fork();
                    }

                    // When a worker dies, respawn
                    cluster.on('exit', function (worker, code, signal) {
                        loggers.errorlog.error('Worker ' + worker.process.pid + ' died');
                        cluster.fork();
                    });
                }
            }
        });

    } else {
        // Worker process
        startWorker();
    }
}
if (!process.env.CDNS_MANUAL_START) {
    startMaster();
} else {
    loggers.errorlog.info("CDNS_MANUAL_START is set, so we will not autostart");
}

// For integration tests...
module.exports = {
    startMaster: startMaster,
    startWorker: startWorker
}

