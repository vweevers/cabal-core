var kappa = require('kappa-core')
var events = require('events')
var inherits = require('inherits')
var memdb = require('memdb')
var thunky = require('thunky')
var timestamp = require('monotonic-timestamp')
var sublevel = require('subleveldown')
var crypto = require('hypercore-crypto')
var url = require('url')
var querystring = require('query-string')
var createChannelView = require('./views/channels')
var createMembershipsView = require('./views/channel-membership')
var createMessagesView = require('./views/messages')
var createTopicsView = require('./views/topics')
var createUsersView = require('./views/users')
var createModerationView = require('./views/moderation')
var swarm = require('./swarm')

var DATABASE_VERSION = 1
var CHANNELS = 'c'
var MEMBERSHIPS = 'j'  // j for joined memberships..? :3 
var MESSAGES = 'm'
var TOPICS = 't'
var USERS = 'u'
var MODERATION = 'x'

module.exports = Cabal
module.exports.databaseVersion = DATABASE_VERSION

/**
 * Create a new cabal. This is the object handling all
 * local nickname -> mesh interactions for a single user.
 * @constructor
 * @param {string|function} storage - A hyperdb compatible storage function, or a string representing the local data path.
 * @param {string} key - a protocol string, optionally with url parameters
 * @param {Object} opts - { modKey }
 */
function Cabal (storage, key, opts) {
  if (!(this instanceof Cabal)) return new Cabal(storage, key, opts)
  if (!opts) opts = {}
  events.EventEmitter.call(this)
  this.setMaxListeners(Infinity)

  var json = {
    encode: function (obj) {
      return Buffer.from(JSON.stringify(obj))
    },
    decode: function (buf) {
      var str = buf.toString('utf8')
      try { var obj = JSON.parse(str) } catch (err) { return {} }
      return obj
    }
  }

  this.maxFeeds = opts.maxFeeds

  if (!key) this.key = generateKeyHex()
  else this.key = sanitizeKey(key)
  if (!isHypercoreKey(this.key)) throw new Error('invalid cabal key')

  this.modKey = opts.modKey

  this.db = opts.db || memdb()
  this.kcore = kappa(storage, {
    valueEncoding: json,
    encryptionKey: isHypercoreKey(this.key) ? this.key : null
  })

  // Create (if needed) and open local write feed
  var self = this
  this.feed = thunky(function (cb) {
    self.kcore.ready(function () {
      self.kcore.writer('local', function (err, feed) {
        cb(feed)
      })
    })
  })

  // views
  this.kcore.use('memberships', createMembershipsView(
    sublevel(this.db, MEMBERSHIPS, { valueEncoding: json })))
  this.kcore.use('channels', createChannelView(
    sublevel(this.db, CHANNELS, { valueEncoding: json })))
  this.kcore.use('messages', createMessagesView(
    sublevel(this.db, MESSAGES, { valueEncoding: json })))
  this.kcore.use('topics', createTopicsView(
    sublevel(this.db, TOPICS, { valueEncoding: json })))
  this.kcore.use('users', createUsersView(
    sublevel(this.db, USERS, { valueEncoding: json })))
  this.kcore.use('moderation', createModerationView(
    this, this.modKey,
    sublevel(this.db, MODERATION, { valueEncoding: json }))
  )

  this.messages = this.kcore.api.messages
  this.channels = this.kcore.api.channels
  this.memberships = this.kcore.api.memberships
  this.topics = this.kcore.api.topics
  this.users = this.kcore.api.users
  this.moderation = this.kcore.api.moderation
}

inherits(Cabal, events.EventEmitter)
Cabal.prototype.getDatabaseVersion = function (cb) {
  if (!cb) cb = noop
  process.nextTick(cb, DATABASE_VERSION)
}

/**
 * Get information about a user that they've volunteered about themselves.
 * @param {String} key - The hex key of the user.
 */
Cabal.prototype.getUser = function (key, cb) {
  if (typeof key === 'function') {
    cb = key
    key = null
  }

  var self = this

  this.feed(function (feed) {
    if (!key) key = feed.key.toString('hex')
    self.kcore.api.users.get(key, cb)
  })
}

/**
 * Publish a message to your feed.
 * @param {String} message - The message to publish.
 * @param {Object} opts - Options
 * @param {function} cb - When message has been successfully added.
 */
Cabal.prototype.publish = function (message, opts, cb) {
  if (!cb) cb = noop
  if (!message) return cb()
  if (typeof opts === 'function') return this.publish(message, null, opts)
  if (!opts) opts = {}

  this.feed(function (feed) {
    message.timestamp = message.timestamp || timestamp()
    feed.append(message, function (err) {
      cb(err, err ? null : message)
    })
  })
}

Cabal.prototype.publishNick = function (nick, cb) {
  // TODO: sanity checks on reasonable names
  if (!cb) cb = noop
  if (!nick) return cb()

  this.feed(function (feed) {
    var msg = {
      type: 'about',
      content: {
        name: nick
      },
      timestamp: timestamp()
    }
    feed.append(msg, cb)
  })
}

Cabal.prototype.publishChannelTopic = function (channel, topic, cb) {
  if (!cb) cb = noop
  if (!channel || typeof channel !== 'string') return cb()
  if (!topic || typeof topic !== 'string') return cb()
  this.feed(function (feed) {
    var msg = {
      type: 'chat/topic',
      content: {
        channel: channel,
        text: topic
      },
      timestamp: timestamp()
    }
    feed.append(msg, cb)
  })
}

Cabal.prototype.getLocalKey = function (cb) {
  if (!cb) return

  this.feed(function (feed) {
    cb(null, feed.key.toString('hex'))
  })
}

Cabal.prototype.swarm = function (opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  swarm(this, opts, cb)
}

Cabal.prototype.replicate = function (opts) {
  opts = opts || {}
  opts = Object.assign({}, {
    live: true,
    maxFeeds: 1024
  }, opts)
  return this.kcore.replicate(opts)
}

Cabal.prototype.ready = function (cb) {
  this.kcore.ready(cb)
}

Cabal.prototype._addConnection = function (key) {
  this.emit('peer-added', key)
}

Cabal.prototype._removeConnection = function (key) {
  this.emit('peer-dropped', key)
}


function generateKeyHex () {
  return crypto.keyPair().publicKey.toString('hex')
}

function isHypercoreKey (key) {
  if (typeof key === 'string') return key.length === 64 && /^[0-9a-f]+$/.test(key)
  else if (Buffer.isBuffer(key)) return key.length === 32
}

// Ensures 'key' is a hex string
function sanitizeKey (key) {
  // force to hex string
  if (Buffer.isBuffer(key)) {
    key = key.toString('hex')
  }

  // remove any protocol uri prefix
  if (typeof key === 'string') key = key.replace(/^.*:\/\//, '')
  else key = undefined

  return key
}

function noop () {}
