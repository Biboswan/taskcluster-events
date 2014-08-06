suite('event', function() {
  var Promise     = require('promise');
  var launch      = require('../bin/server');
  var SockJS      = require('sockjs-client-node');
  var assert      = require('assert');
  var slugid      = require('slugid');
  var taskcluster = require('taskcluster-client');
  var debug       = require('debug')('test:event');
  var base        = require('taskcluster-base');

  // Load configuration
  var cfg = base.config({
    defaults:     require('../config/defaults'),
    profile:      require('../config/test'),
    envs:         [
      'taskcluster_credentials_clientId',     // Only for testing
      'taskcluster_credentials_accessToken',  // Only for testing
      'amqp_url'
    ],
    filename:     'taskcluster-events'
  });

  // Check that we have credentials to run these test
  if (!cfg.get('amqp:url') || !cfg.get('taskcluster:credentials:accessToken')) {
    console.log("Skipping event_test.js due to missing configuration");
    return;
  }

  var socket = null;
  var server = null;
  var ready = null;
  setup(function() {
    return launch('test').then(function(server_) {
      server = server_;
    }).then(function() {
      socket = new SockJS('http://localhost:60002/v1/listen');
      ready = new Promise(function(accept) {
        socket.addEventListener('open', function() {
          debug('open');
          socket.addEventListener('message', function(e) {
            var message = JSON.parse(e.data);
            if (JSON.parse(e.data).method === 'ready') {
              accept();
            }
          });
        });
      });
    });
  });

  teardown(function() {
    return new Promise(function(accept) {
      socket.onclose = accept;
      socket.close();
    }).then(function() {
      return server.terminate();
    });
  });

  test('connect', function() {
    return ready.then(function() {
      assert(socket.readyState === 1, "Expect socket to be ready!");
    });
  });

  test('bind', function() {
    var bound = new Promise(function(accept, reject) {
      socket.addEventListener('message', function(e) {
        var message = JSON.parse(e.data);
        if (message.method === 'bound') {
          accept();
        }
        if (message.method === 'error') {
          debug("Got error: %j", message);
          reject();
        }
      });
    });
    var queueEvents = new taskcluster.QueueEvents();
    return ready.then(function() {
      socket.send(JSON.stringify({
        method:   'bind',
        binding:  queueEvents.taskPending({
          taskId: slugid.v4()
        })
      }));
      return bound;
    });
  });


  test('bind', function() {
    this.timeout(10000);
    var taskId = slugid.v4();
    var gotMessage = new Promise(function(accept, reject) {
      socket.addEventListener('message', function(e) {
        var message = JSON.parse(e.data);
        if (message.method === 'message') {
          accept(message.message);
        }
        if (message.method === 'error') {
          debug("Got error: %j", message);
          reject();
        }
      });
    });
    var queueEvents = new taskcluster.QueueEvents();
    return ready.then(function() {
      socket.send(JSON.stringify({
        method:   'bind',
        binding:  queueEvents.taskDefined({
          taskId:     taskId
        })
      }));
    }).then(function() {
      var queue = new taskcluster.Queue({
        credentials:  cfg.get('taskcluster:credentials')
      });
      var deadline = new Date();
      deadline.setHours(deadline.getHours() + 2);
      return queue.defineTask(taskId, {
        provisionerId:    "dummy-test-provisioner",
        workerType:       "dummy-test-worker-type",
        schedulerId:      "dummy-test-scheduler",
        taskGroupId:      taskId,
        scopes:           [],
        routing:          "",
        retries:          3,
        priority:         5,
        created:          (new Date()).toJSON(),
        deadline:         deadline.toJSON(),
        payload:          {},
        metadata: {
          name:           "Print `'Hello World'` Once",
          description:    "This task will prìnt `'Hello World'` **once**!",
          owner:          "jojensen@mozilla.com",
          source:         "https://github.com/taskcluster/taskcluster-events"
        },
        tags: {
          objective:      "Test taskcluster-event"
        }
      });
    }).then(function() {
      return gotMessage;
    }).then(function(result) {
      assert(result.payload.status.taskId === taskId, "Got wrong taskId");
    });
  });
});