var crypto = require('crypto'),
    dgram = require('dgram'),
    redis = require('redis'),
    utile = require('utile'),
    async = require('async'),
    msgpack = require('msgpack-js');

var server = exports;

function Server(options) {
  this.options = utile.mixin({
    redis: {
      port: 6379,
      host: 'localhost'
    },
    expireTimeout: 5 * 60
  }, options || {});

  this.redis = redis.createClient(this.options.redis.port,
                                  this.options.redis.host);

  this.socket = dgram.createSocket('udp4');
  this.socket.on('message', this.onmessage.bind(this));

  this.version = [0, 1];
  this.expireTimeout = this.options.expireTimeout;
};

server.create = function create(options) {
  return new Server(options);
};

Server.prototype.listen = function listen(port, host) {
  this.socket.bind(port, host);
};

Server.prototype.onmessage = function onmessage(raw, client) {
  var self = this;

  try {
    var msg = msgpack.decode(raw);
  } catch (e) {
    this.emit(e);
    return;
  }

  function send(protocol, data, client) {
    try {
      data.protocol = protocol;
      data.seq = msg.seq;
      var buff = msgpack.encode(data);
    } catch (e) {
      self.emit('error', e);
    }

    self.socket.send(buff, 0, buff.length, client.port, client.address);
  }

  function reply(data) {
    return send('api', data, client);
  }

  if (msg.protocol === 'api') {
    if (msg.type === 'create' || msg.type === 'connect') {
      this.handleCreate(msg, client, reply);
    } else if (msg.type === 'info') {
      this.handleInfo(msg, client, reply);
    }
  } else if (msg.protocol === 'relay' && msg.id && msg.to) {
    msg.from = {
      address: client.address,
      family: client.family,
      port: client.port
    };

    this.getInfo(msg.id, client, function(err, recipients) {
      // Do nothing on error
      if (err) return;

      var valid = recipients.some(function(addr) {
        return addr.address === msg.to.address && addr.port === msg.to.port;
      });

      if (!valid) return;

      send('relay', msg, msg.to);
    });
  }
};

Server.prototype.handleCreate = function handleCreate(msg, client, reply) {
  var self = this,
      id = msg.id ||
           crypto.createHash('sha1').update(crypto.randomBytes(256))
                                    .digest('hex');

  var ports = [client.port];

  if (msg.port && client.port !== msg.port) ports.push(msg.port);

  ports.forEach(function(port) {
    var addr = {
      address: client.address,
      family: client.family,
      port: port
    };

    // Create room
    this.redis.lpush(id, JSON.stringify(addr), function(err) {
      if (err) return self.emit('error', err);

      // Send response back to client
      if (!msg.id) {
        reply({
          type: 'create-response',
          id: id
        });
      } else {
        self.handleInfo(msg, client, reply);
      }
    });
    this.redis.expire(id, this.expireTimeout);
  }, this);
};

Server.prototype.handleInfo = function handleInfo(msg, client, reply) {
  var self = this;

  // Id is required
  if (!msg.id) return;

  this.getInfo(msg.id, client, function(err, members) {
    if (err) {
      reply({
        type: 'error',
        reason: err,
        id: id
      });
      return;
    }

    reply({
      type: 'info',
      id: msg.id,
      members: members.filter(function(member) {
        if (!msg.port) return true;

        return member.address !== client.address ||
               member.port !== msg.port;
      })
    });
  });
  this.redis.expire(msg.id, this.expireTimeout);
};

Server.prototype.getInfo = function getInfo(id, client, callback) {
  var self = this;

  // Fetch room
  this.redis.llen(id, function(err, len) {
    if (err) return callback('no such room');

    var arr = [];
    for (var i = 0; i < len; i++) arr.push(i);

    async.map(arr, function each(i, callback) {
      self.redis.lindex(id, i, callback)
    }, function after(err, results) {
      if (err) return callback('no such room');

      callback(null, results.map(function(data) {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }).filter(function(addr) {
        return addr !== null &&
               (addr.address !== client.address ||
               addr.port !== client.port);
      }));
    });
  });
};
