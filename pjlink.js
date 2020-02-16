var net = require('net');
var instance_skel = require('../../instance_skel');
var crypto = require('crypto');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.commands = [];

	self.status(self.STATUS_UNKNOWN, 'Connecting');

	// Initial connect to check status
	self.send('%1POWR ?');
};

instance.prototype.init_tcp = function(cb) {
	var self = this;
	var receivebuffer = '';

	if (self.socketTimer) {
		clearInterval(self.socketTimer);
		delete self.socketTimer;
	}

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.connecting = true;
		self.commands = [];
		self.socket = new net.Socket();
		self.socket.setNoDelay(true);

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.status(self.STATE_ERROR, err);
			self.log('error',"Network error: " + err.message);
			self.connected = false;
			self.connecting = false;
			delete self.socket;
		});

		self.socket.on('connect', function () {
			receivebuffer = '';
			self.connect_time = Date.now();

			if (self.currentStatus != self.STATUS_OK) {
				self.status(self.STATUS_OK, 'Connected');
			}

			self.connected = true;
		})

		self.socket.on('end', function () {
			self.connected = false;
			self.connecting = false;
		});

		self.socket.on('data', function (chunk) {
			// separate buffered stream into lines with responses
			var i = 0, line = '', offset = 0;
			receivebuffer += chunk;
			while ( (i = receivebuffer.indexOf('\r', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset);
				offset = i + 1;
				self.socket.emit('receiveline', line.toString());
			}
			receivebuffer = receivebuffer.substr(offset);
		});

		self.socket.on('receiveline', function (data) {
			self.connect_time = Date.now();

			if (data.match(/^PJLINK 0/)) {
				// no auth
				if (typeof cb == 'function') {
					cb();
				}
				return;
			}

			if (data.match(/^PJLINK ERRA/)) {
				self.log('error', 'Authentication error. Password not accepted by projector');
				self.commands.length = 0;
				self.status(self.STATUS_ERROR, 'Authenticatione error');
				self.connected = false;
				self.connecting = false;
				self.socket.destroy();
				delete self.socket;
				return;
			}

			var match;
			if (match = data.match(/^PJLINK 1 (\S+)/)) {
				var digest = match[1] + self.config.password;
				var hasher = crypto.createHash('md5');
				var hex = hasher.update(digest, 'utf-8').digest('hex');
				self.socket.write(hex);

				// Shoot and forget, by protocol definition :/
				if (typeof cb == 'function') {
					cb();
				}
			}

			if (self.commands.length) {
				var cmd = self.commands.shift();

				self.socket.write(cmd + "\r");
			} else {
				clearInterval(self.socketTimer);

				self.socketTimer = setInterval(function () {

					if (self.commands.length > 0) {
						var cmd = self.commands.shift();
						self.connect_time = Date.now();
						self.socket.write(cmd + "\r");
						clearInterval(self.socketTimer);
						delete self.socketTimer;
					}

					if (Date.now() - self.connect_time > 2000) {

						if (self.socket !== undefined && self.socket.destroy !== undefined) {
							self.socket.destroy();
						}

						delete self.socket;
						self.connected = false;
						self.connecting = false;

						if (self.socketTimer) {
							clearInterval(self.socketTimer);
							delete self.socketTimer;
						}

						debug("disconnecting per protocol defintion :(");
					}
				}, 100);
			}
		});

		self.socket.connect(4352, self.config.host);
	}
};

instance.prototype.send = function(cmd) {
	var self = this;

	if (self.connecting) {
		self.commands.push(cmd);
	} else {
		self.init_tcp(function () {
			self.connect_time = Date.now();

			self.socket.write(cmd + "\r");
		});
	}
};


// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 6,
			regex: self.REGEX_IP
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'PJLink password (empty for none)',
			width: 6
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}
};


instance.prototype.actions = function(system) {
	var self = this;

	self.system.emit('instance_actions', self.id, {
		'powerOn':        { label: 'Power On Projector' },
		'powerOff':       { label: 'Power Off Projector' },
		'shutterOpen':    { label: 'Open Shutter' },
		'shutterClose':   { label: 'Close Shutter' },
		'freeze':         { label: 'Freeze Input' },
		'unfreeze':       { label: 'Unfreeze Input' }

	});
};

instance.prototype.action = function(action) {
	var self = this;
	var id = action.action;
	var cmd

	switch (action.action){

		case 'powerOn':
			cmd = '%1powr 1';
			break;

		case 'powerOff':
			cmd = '%1powr 0';
			break;

		case 'shutterOpen':
			cmd = '%1avmt 30';
			break;

		case 'shutterClose':
			cmd = '%1avmt 31';
			break;

		case 'freeze':
			cmd = '%2frez 1';
			break;

		case 'unfreeze':
			cmd = '%2frez 0';
			break;

	};




	if (cmd !== undefined) {

		debug('sending ',cmd,"to",self.config.host);

		self.send(cmd);
	}

	// debug('action():', action);

};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
