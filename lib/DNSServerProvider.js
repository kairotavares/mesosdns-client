"use strict";
var EventEmitter = require('events').EventEmitter,
    Util = require('util'),
    ndns = require('native-dns');

var DNSServiceProvider = function DNSServiceProvider(options) {
    var self = this;
    EventEmitter.call(self);

    // Interval cache
    self.intervals = {};
    // Configured DNS servers
    self.dnsServers = [];
    // Available DNS servers based on health check
    self.availableDnsServers = [];
    // Is health checking enabled?
    self.healthCheckEnabled = false;
    // Health check interval = 30 secs
    self.healthCheckInterval = 30000;
    // DNS timeout
    self.dnsTimeout = 1000;
    // Check domain for DNS resolution
    self.healthCheckDomain = 'www.google.com';

    if (options && options.hasOwnProperty('dnsServers') && Array.isArray(options['dnsServers']) && options['dnsServers'].length > 0) {
        self.dnsServers = self.dnsServers.concat(options['dnsServers']);
    } else {
        self.emit('error', { error: 'No DNS servers in configuration. Exiting.' });
    }

    if (options && options.hasOwnProperty('dnsTimeout')) {
        self.dnsTimeout = options['dnsTimeout'];
    }

    if (options && options.hasOwnProperty('healthCheckDomain')) {
        self.healthCheckDomain = options['healthCheckDomain'];
    }

    if (options && options.hasOwnProperty('healthCheckEnabled')) {
        self.healthCheckEnabled = options['healthCheckEnabled'];
    }

    if (options && options.hasOwnProperty('healthCheckInterval')) {
        self.healthCheckInterval = options['healthCheckInterval'];
    }

    self.answerCallback = function(err, answer) {
        if (err) {
            if (self.availableDnsServers.indexOf(answer.dnsServerIp) > -1) {
                //Remove from available DNS servers
                self.availableDnsServers.splice(self.availableDnsServers.indexOf(answer.dnsServerIp), 1);
                // Emit event
                self.emit('removeServer', answer.dnsServerIp);
            }
        } else {
            if (self.availableDnsServers.indexOf(answer.dnsServerIp) === -1) {
                //Add to available DNS servers
                self.availableDnsServers.push(answer.dnsServerIp);
                // Emit event
                self.emit('addServer', answer.dnsServerIp);
            }
        }
    };

    if (self.dnsServers.length > 1) {
        self.dnsServers.forEach(function(dnsServer) {
            // Startup usage
            self.healthCheck.call(self, dnsServer, self.answerCallback);
            // Recurring usage
            if (self.healthCheckEnabled) {
                self.intervals[dnsServer] = setInterval(self.healthCheck.bind(self), self.healthCheckInterval, dnsServer, self.answerCallback);
            }
        });
    }

};

Util.inherits(DNSServiceProvider, EventEmitter);

DNSServiceProvider.prototype.healthCheck = function(dnsServerIp, callback) {

    var self = this,
        reqAnswer = {
            dnsServerIp: dnsServerIp
        },
        error = null;

    var question = ndns.Question({
        name: self.healthCheckDomain,
        type: 'A'
    });

    var start = new Date().getTime();

    var req = ndns.Request({
        question: question,
        server: { address: dnsServerIp, port: 53, type: 'udp' },
        timeout: self.dnsTimeout
    });

    req.on('timeout', function () {
        self.emit('timeout', dnsServerIp);
        error = {error: 'timeout'};
    });

    req.on('message', function (err, answer) {
        if (err) {
            self.emit('error', {dnsServerIp: dnsServerIp, error: err });
            error = {error: err, dnsServerIp: dnsServerIp};
        } else {
            reqAnswer.answer = answer.answer;
        }
    });

    req.on('end', function () {
        reqAnswer.runtime = (new Date().getTime()-start);
        callback(error, reqAnswer);
    });

    req.send();

};

DNSServiceProvider.prototype.getDnsServer = function() {
    if (this.availableDnsServers.length > 0) {
        return this.availableDnsServers[Math.floor(Math.random()*this.availableDnsServers.length)];
    } else {
        return this.dnsServers[Math.floor(Math.random()*this.dnsServers.length)];
    }
};

DNSServiceProvider.prototype.removeDnsServer = function(dnsServerIp) {
    if (this.availableDnsServers.indexOf(dnsServerIp) > -1) {
        //Remove
        this.availableDnsServers.splice(this.availableDnsServers.indexOf(dnsServerIp), 1);
        this.emit('removeServer', dnsServerIp);
    }
};

module.exports = DNSServiceProvider;