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
    }
  }, options || {});

  this.redis = redis.createClient(this.options.redis.port,
                                  this.options.redis.host);

  this.socket = dgram.createSocket('udp4');
  this.socket.on('message', this.onmessage.bind(this));

  this.version = [0, 1];
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

  function reply(data) {
    try {
      data.seq = msg.seq;
      var buff = msgpack.encode(data);
    } catch (e) {
      self.emit('error', e);
    }

    self.socket.send(buff, 0, buff.length, client.port, client.address);
  }

  if (msg.type === 'create' || msg.type === 'connect') {
    this.handleCreate(msg, client, reply);
  } else if (msg.type === 'info') {
    this.handleInfo(msg, client, reply);
  }
};

Server.prototype.handleCreate = function handleCreate(msg, client, reply) {
  var self = this,
      id = msg.id ||
           crypto.createHash('sha1').update(crypto.randomBytes(256))
                                    .digest('hex');

  var addr = {
    address: client.address,
    family: client.family,
    port: client.port
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
};

Server.prototype.handleInfo = function handleInfo(msg, client, reply) {
  var self = this;

  // Id is required
  if (!msg.id) return;

  // Fetch room
  this.redis.llen(msg.id, function(err, len) {
    if (err) {
      reply({
        type: 'error',
        reason: 'no such room',
        id: id
      });
      return;
    }

    var arr = [];
    for (var i = 0; i < len; i++) arr.push(i);

    async.map(arr, function each(i, callback) {
      self.redis.lindex(msg.id, i, callback)
    }, function after(err, results) {
      if (err) {
        reply({
          type: 'error',
          reason: 'no such room',
          id: msg.id
        });
        return;
      }

      reply({
        type: 'info',
        id: msg.id,
        members: results.map(function(data) {
          try {
            return JSON.parse(data);
          } catch (e) {
            return null;
          }
        }).filter(function(addr) {
          return addr != null &&
                 (addr.address !== client.address ||
                 addr.port !== client.port);
        })
      });
    });
  });
};
