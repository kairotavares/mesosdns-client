# mesosdns-client
A NPM package that resolves Mesos service URLs to actual host/port endpoints.

## Installation

This package can be installed via running `npm install mesosdns-client --save`.

## Options

The following options are available:

- `dnsServers`: The array of available Mesos DNS servers (IP addresses)
- `mesosTLD`: The TLD of Mesos, as defined in the Mesos DNS settings (default `.mesos`)
- `dnsTimeout`: The timeout in milliseconds after which a DNS request is considered as timed out
- `defaultPortIndex`: The global default *"port index"* which should be use (default is `0`). Can be useful if querying services with multiple ports. To use the `portIndex` per call, see the `get(serviceName, options, callback)` function.  
- `strategy`: The strategy to choose an endpoint which should be used if there are more then one instances of the service/application. Default is `weighted` (by DNS prio/weight), or `random`.   
- `healthCheckEnabled`: If the health checks should be enabled (default is `false`). Should be set to `true` is `mesosdns-client` is used in a long-running application. This will then trigger recurrent health checks.
- `healthCheckInterval`: The health check intervall in milliseconds (default is `10000`). Should only be used if `healthCheckEnabled` is `true`
- `useEvents`: Currently this just enables the displaying of debugging messages from the health checks if set to `true` (default is `false`) 

## Usage

To use the `mesosdns-client`, the Mesos DNS services have to be deployed (ideally) on each Mesos Slave. For example, if there's a web application deployed via Marathon (called `web`) on three instances, 
and Mesos DNS runs on the servers `192.168.0.100`, `192.168.0.101` and `192.168.0.102`, we can use it like this:

### Basic usage

```
var MesosDNSClient = require("mesosdns-client");

var options = {
    dnsServers: ["192.168.0.100", "192.168.0.101", "192.168.0.102"],
    mesosTLD: ".mesos"
};

var client = new MesosDNSClient(options);

client.get("web.marathon.mesos", function(error, addressInfo) {
    if (error) console.log(JSON.stringify(error));
    
    console.log("The complete addressInfo is: " + JSON.stringify(addressInfo));
    console.log("The endpoint is: " + JSON.stringify(addressInfo.endpoint));
    
});
```

will print

```
The complete addressInfo is: {"hostname":"web.marathon.mesos","endpoint":"192.168.0.100:31302","host":"192.168.0.100","port":31302,"allEndpoints":[{"port":31302,"host":"192.168.0.100"},{"port":31205,"host":"192.168.0.101"},{"port":31695,"host":"192.168.0.102"}],"took":"18"}
The endpoint is: "192.168.200.168:31302"
```

### Advanced usage

If you want to query services which open more than one port (i.e. a specific port), you can use the `options` object of the `get()` to specify the `portIndex` property (starting with `0`):

```
client.get("web.marathon.mesos", { portIndex: 1 }, function(error, addressInfo) {
    if (error) console.log(JSON.stringify(error));
    
    console.log("The complete addressInfo is: " + JSON.stringify(addressInfo));
    console.log("The endpoint is: " + JSON.stringify(addressInfo.endpoint));
    
});
```

In this case, the `client` would return the endpoints for the second port (per instance) which is opened by Marathon.