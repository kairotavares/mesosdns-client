var ndns = require('native-dns'),
    DnsServerProvider = require('./lib/DNSServerProvider');

var internals = {};

internals.compareNumbers = function compareNumbers(a, b) {
    a = parseInt(a, 10);
    b = parseInt(b, 10);
    return (a < b ? -1 : (a > b ? 1 : 0));
};

internals.checkBoolean = function checkBoolean(bool) {
    return typeof bool === 'boolean' ||
        (typeof bool === 'object' && typeof bool.valueOf() === 'boolean');
};

internals.random = function random(addrs) {
    var temp = [];
    temp.push(addrs[Math.floor(Math.random()*addrs.length)]);
    return temp;
};

// Sorts the SRV lookup results first by priority, then randomising the server
// order for a given priority. For discussion of handling of priority and
// weighting, see https://github.com/dhruvbird/dns-srv/pull/4
internals.groupSrvRecords = function groupSrvRecords(addrs) {
    var groups = {};  // by priority
    addrs.forEach(function(addr) {
        if (!groups.hasOwnProperty(addr.priority)) {
            groups[addr.priority] = [];
        }

        groups[addr.priority].push(addr);
    });

    var result = [];
    Object.keys(groups).sort(internals.compareNumbers).forEach(function(priority) {
        var group = groups[priority];
        // Calculate the total weight for this priority group
        var totalWeight = 0;
        group.forEach(function(addr) {
            totalWeight += addr.weight;
        });
        while (group.length > 1) {
            // Select the next address (based on the relative weights)
            var w = Math.floor(Math.random() * totalWeight);
            var index = -1;
            while (++index < group.length && w > 0) {
                w -= group[index].weight;
            }
            if (index < group.length) {
                // Remove selected address from the group
                var addr = group.splice(index, 1)[0];
                // Remove unnecessary properties
                delete addr.weight;
                delete addr.priority;
                // Add it to the result list.
                result.push(addr);
                // Adjust the total group weight accordingly
                totalWeight -= addr.weight;
            }
        }
        // Remove unnecessary properties
        delete group[0].weight;
        delete group[0].priority;
        // Add the final address from this group
        result.push(group[0]);
    });
    return result;
};


var MesosDNSClient = function MesosDNSClient(options) {

    this.dnsServerProvider = null;
    this.mesosTLD = '.mesos';
    this.dnsTimeout = 1000;
    this.healthCheckEnabled = false;
    this.healthCheckInterval = 10000;
    this.useEvents = false;
    this.strategy = internals.groupSrvRecords;

    // The cache object is used to provide a fallback if the DNS server
    // health check has not yet removed a failed DNS server from the list of available DNS servers
    this.cache = {};

    if (options && options.hasOwnProperty('mesosTLD')) {
        this.mesosTLD = options['mesosTLD'];
    }

    if (options && options.hasOwnProperty('dnsTimeout')) {
        this.dnsTimeout = options['dnsTimeout'];
    }

    if (options && options.hasOwnProperty('strategy')) {
        if (options["strategy"].toLowerCase() === "random") {
            this.strategy = internals.random;
        } else if (options["strategy"].toLowerCase() === "weighted") {
            // ignore, is the standard strategy
        } else {
            console.log("You specified an invalid strategy! Fallback to default strategy 'weighted'...");
        }
    }

    if (options && options.hasOwnProperty('healthCheckEnabled') && internals.checkBoolean(options['healthCheckEnabled'])) {
        this.healthCheckEnabled = options['healthCheckEnabled'];
    }

    if (options && options.hasOwnProperty('healthCheckInterval')) {
        this.healthCheckInterval = options['healthCheckInterval'];
    }

    if (options && options.hasOwnProperty('useEvents') && (options['useEvents'] === true || options['useEvents'] === false)) {
        this.useEvents = options['useEvents'];
    }

    if (options && options.hasOwnProperty('dnsServers')) {
        var dnsServers = null;
        if (typeof options['dnsServers'] === 'string') {
            dnsServers = new Array(options['dnsServers']);
        }
        if (Array.isArray(options['dnsServers'])) {
            dnsServers = options['dnsServers'];
        }
        if (dnsServers) {
            this.dnsServerProvider = new DnsServerProvider({
                dnsServers: dnsServers,
                healthCheckEnabled: this.healthCheckEnabled,
                healthCheckInterval: this.healthCheckInterval,
                dnsTimeout: this.dnsTimeout
            });
        }
    }

    //Activate events
    if (this.dnsServerProvider && this.useEvents) {
        this.dnsServerProvider.on('addServer', function(ip){
            console.log(new Date().getTime() + ': Added ' + ip + ' Now online: ' + JSON.stringify(this.availableDnsServers));
        });

        this.dnsServerProvider.on('removeServer', function(ip){
            console.log(new Date().getTime() + ': Removed ' + ip + ' Now online: ' + JSON.stringify(this.availableDnsServers));
        });

        this.dnsServerProvider.on('timeout', function(ip){
            console.log(new Date().getTime() + ': Timeout ' + ip);
        });

        this.dnsServerProvider.on('error', function(message){
            console.log(new Date().getTime() + ': Error ' + message.error + ' from ' + message.dnsServerIp);
        });
    }

};

MesosDNSClient.prototype.get = function (hostname, callback) {
    var self = this;

    //Check if a URL containing the specific Mesos domain is requested
    if (hostname.indexOf(this.mesosTLD) > -1) {

        self.resolve(hostname, function(err, services, timing) {

            var _services = [];

            if (err || services.length === 0) {
                // Lookup hostname in the cache
                if (self.cache.hasOwnProperty(hostname)) {
                    // If found, use it
                    _services = self.cache[hostname];
                } else {
                    // Return error
                    callback({
                        "message": err
                    }, null);
                }
            } else {
                // Set local services array
                _services = services;
                // Update cache
                self.cache[hostname] = services;
            }

            var endpoints = self.strategy(_services);

            callback(null, {
                hostname: hostname,
                endpoint: endpoints[0].host + ":" + endpoints[0].port,
                host: endpoints[0].host,
                port: endpoints[0].port,
                allEndpoints: endpoints,
                took: timing
            })

        });

    //If not, just forward
    } else {
        callback({
            "message": "The hostname " + hostname + " doesn't contain a valid TLD."
        }, {
            hostname: hostname,
            address: hostname,
            all: [],
            took: 0
        });
    }

};

MesosDNSClient.prototype.resolve = function(hostname, callback) {
    var self = this;
    var question = ndns.Question({
        name: self.getServiceName(hostname),
        type: 'SRV'
    });

    var start = Date.now();
    var mapping = {};
    var dnsServer = self.dnsServerProvider.getDnsServer();

    var req = ndns.Request({
        question: question,
        server: { address: dnsServer, port: 53, type: 'udp' },
        timeout: self.dnsTimeout
    });

    req.on('timeout', function () {
        self.dnsServerProvider.removeDnsServer(dnsServer);
        callback('Timeout in making request', null);
    });

    req.on('message', function (err, answer) {
        if (err) {
            //callback(err, null);
            self.dnsServerProvider.removeDnsServer(dnsServer);
            self.resolve.call(self, hostname, callback);
        }

        //Standard SRV records (hostname, priority and weight)
        answer.answer.forEach(function (a) {
            mapping[a.target] = {
                port: a.port,
                priority: a.priority,
                weight: 10 //Use same weight
            };
        });

        //Special case for Mesos DNS: It returns the A records  for each SRV record hostname as well in the additional section
        answer.additional.forEach(function (a) {
            if (mapping[a.name]) {
                mapping[a.name].host = a.address;
            }
        });

    });

    req.on('end', function () {
        //From "HashMap" to array
        var services = [];
        Object.getOwnPropertyNames(mapping).forEach(function(service) {
            services.push(mapping[service]);
        });
        callback(null, services, ((Date.now()) - start).toString());
    });

    req.send();

};

MesosDNSClient.prototype.getServiceName = function(host) {
    var parts = host.split('\.');
    var requestAddress = '_' + parts.shift() + '._tcp.' + parts.join('.');
    return requestAddress;
};

module.exports = MesosDNSClient;
