var util = require('util'),
    ndns = require('native-dns'),
    DnsServerProvider = require('./lib/DNSServerProvider');

var internals = {};

// Sort numbers
internals.compareNumbers = function compareNumbers(a, b) {
    a = parseInt(a, 10);
    b = parseInt(b, 10);
    return (a < b ? -1 : (a > b ? 1 : 0));
};

// Sort address objects by port
internals.byPort = function byPort(a,b) {
    if (a.port < b.port)
        return -1;
    if (a.port > b.port)
        return 1;
    return 0;
};

// Check if passed value is an object
internals.isObject = function isObject(item) {
    return (typeof item === "object" && !Array.isArray(item) && item !== null);
};

// Check if passed value is an object
internals.isFunction = function isObject(item) {
    return util.isFunction(item);
};

// Verify if passed value is a Boolean
internals.isBoolean = function isBoolean(bool) {
    return typeof bool === 'boolean' ||
        (typeof bool === 'object' && typeof bool.valueOf() === 'boolean');
};

// Select a random entry from the address array
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
    this.defaultPortIndex = 0; // Use the first entry by default

    // The cache object is used to provide a fallback if the DNS server
    // health check has not yet removed a failed DNS server from the list of available DNS servers
    this.cache = {};

    if (options && options.hasOwnProperty('mesosTLD')) {
        this.mesosTLD = options['mesosTLD'];
    }

    if (options && options.hasOwnProperty('dnsTimeout')) {
        this.dnsTimeout = options['dnsTimeout'];
    }

    if (options && options.hasOwnProperty('defaultPortIndex')) {
        this.defaultPortIndex = options['defaultPortIndex'];
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

    if (options && options.hasOwnProperty('healthCheckEnabled') && internals.isBoolean(options['healthCheckEnabled'])) {
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

    // Activate events
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

MesosDNSClient.prototype.get = function (serviceName, options, callback) {
    var self = this,
        _callback = null,
        _portIndex = null;

    if (arguments.length === 2 && internals.isFunction(arguments[1])) {
        _callback = arguments[1];
        // Set portIndex to default
        _portIndex = self.defaultPortIndex;
    } else if (arguments.length === 3 && internals.isFunction(arguments[2])) {
        _callback = arguments[2];
        // Check if second argument is object and contains the portIndex property
        if (internals.isObject(arguments[1]) && arguments[1].hasOwnProperty("portIndex")) {
            _portIndex = arguments[1]["portIndex"];
        } else {
            _portIndex = self.defaultPortIndex;
        }
    }

    // Check if a URL containing the specific Mesos domain is requested
    if (serviceName.indexOf(this.mesosTLD) > -1) {

        self.resolve(serviceName, _portIndex, function(err, services, timing) {

            var _services = [];

            if (err || services.length === 0) {
                // Lookup serviceName in the cache
                if (self.cache.hasOwnProperty(serviceName)) {
                    // If found, use it
                    _services = self.cache[serviceName];
                } else {
                    // Return error
                    _callback({
                        "message": err
                    }, null);
                }
            } else {
                // Set local services array
                _services = services;
                // Update cache
                self.cache[serviceName] = services;
            }

            var endpoints = self.strategy(_services);

            if (endpoints.length > 0) {
                _callback(null, {
                    serviceName: serviceName,
                    endpoint: endpoints[0].host + (endpoints[0].hasOwnProperty("port") ? ":" + endpoints[0].port : ""),
                    //endpoint: endpoints[0].host + ":" + endpoints[0].port,
                    host: endpoints[0].host,
                    port: endpoints[0].port,
                    allEndpoints: endpoints,
                    took: timing
                });
            } else {
                _callback({
                    "message": "The service " + serviceName + " couldn't by found in the Mesos DNS. Check if it exists."
                }, null);
            }

        });

    // If not, just forward
    } else {
        _callback({
            "message": "The serviceName " + serviceName + " doesn't contain a valid TLD."
        }, {
            serviceName: serviceName,
            address: serviceName,
            all: [],
            took: 0
        });
    }

};

MesosDNSClient.prototype.resolve = function(hostname, portIndex, callback) {
    var self = this;
    var questionObj = self.getQuestionObject(hostname);
    var question = ndns.Question(questionObj);

    var start = Date.now();
    var mapping = {};
    var dnsServer = self.dnsServerProvider.getDnsServer();

    var req = ndns.Request({
        question: question,
        server: { address: dnsServer, port: 53, type: 'tcp' },
        timeout: self.dnsTimeout
    });

    req.on('timeout', function () {
        self.dnsServerProvider.removeDnsServer(dnsServer);
        callback('Timeout in making request', null);
    });

    req.on('message', function (err, answer) {

        if (err) {
            self.dnsServerProvider.removeDnsServer(dnsServer);
            self.resolve.call(self, hostname, portIndex, callback);
        }

        if (questionObj.type === "SRV") {
            // Standard SRV records (hostname, priority and weight)
            answer.answer.forEach(function (a) {

                if (mapping[a.target] && mapping[a.target].endpoints) {
                    // Add endpoint
                    mapping[a.target].endpoints.push({
                        port: a.port,
                        priority: a.priority,
                        weight: 10 //Use same weight
                    });
                } else {
                    // Create mapping entry
                    mapping[a.target] = {
                        host: null,
                        type: questionObj.type,
                        endpoints: [{
                            port: a.port,
                            priority: a.priority,
                            weight: 10 //Use same weight
                        }]
                    }
                }

            });

            // Special case for Mesos DNS: It returns the A records  for each SRV record hostname as well in the additional section
            answer.additional.forEach(function (a) {
                if (mapping[a.name]) {
                    mapping[a.name].host = a.address;
                }
            });
        } else {
            // A record
            answer.answer.forEach(function (a) {

                if (mapping[a.name] && mapping[a.name].endpoints) {
                    // Add endpoint
                    mapping[a.name].endpoints.push({
                        host: a.address,
                        weight: 10 //Use same weight
                    });
                } else {
                    // Create mapping entry
                    mapping[a.name] = {
                        host: a.address,
                        type: questionObj.type,
                        endpoints: [{
                            host: a.address,
                            weight: 10 //Use same weight
                        }]
                    }
                }

            });
        }


    });

    req.on('end', function () {

        var services = [];

        if (mapping[hostname].type === "SRV") {

            // From dictionary to array
            Object.getOwnPropertyNames(mapping).forEach(function(service) {

                // Sort by port (it's already sorted by host!)
                var sortedEndpoints = mapping[service].endpoints.sort(internals.byPort);

                // Check portIndex constraint validity, fallback to first entry in case it's greater then the returned endpoints' length
                var index = 0;
                if (portIndex <= sortedEndpoints.length-1) {
                    index = portIndex;
                }

                // Construct final object
                var chosenEndpoint = sortedEndpoints[index];
                chosenEndpoint.host = mapping[service].host;

                // Push to services array
                services.push(chosenEndpoint);

            });

            callback(null, services, ((Date.now()) - start).toString());

        } else {

            callback(null, mapping[hostname].endpoints, ((Date.now()) - start).toString());

        }


    });

    req.send();

};

MesosDNSClient.prototype.getQuestionObject = function(host) {
    var resultObj = {};
    var parts = host.split('\.');
    if (parts && parts.length === 2) {
        resultObj.name = host;
        resultObj.type = "A";
    } else {
        resultObj.name = '_' + parts.shift() + '._tcp.' + parts.join('.');
        resultObj.type = "SRV";
    }
    return resultObj;
};

module.exports = MesosDNSClient;
