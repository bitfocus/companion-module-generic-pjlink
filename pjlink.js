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
	self.init_tcp();

};

instance.prototype.init_tcp = function(cb) {
	var self = this;
	var receivebuffer = '';
	self.passwordstring = '';

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
				debug('Connected to projector');
			}

			self.connected = true;
		})

		self.socket.on('end', function () {
			self.connected = false;
			self.connecting = false;
			debug('Disconnected');
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

			debug('PJLINK: < ' + data);


			if (data.match(/^PJLINK ERRA/)) {
				debug('Password not accepted');
				self.log('error', 'Authentication error. Password not accepted by projector');
				self.commands.length = 0;
				self.status(self.STATUS_ERROR, 'Authentication error');
				self.connected = false;
				self.connecting = false;
				self.socket.destroy();
				delete self.socket;
				return;
			}

			if (data.match(/^PJLINK 0/)) {
				debug('Projector does not need password');
				self.passwordstring = '';

				// no auth
				if (typeof cb == 'function') {
					cb();
				}
			}

			var match;
			if (match = data.match(/^PJLINK 1 (\S+)/)) {
				var digest = match[1] + self.config.password;
				var hasher = crypto.createHash('md5');
				var hex = hasher.update(digest, 'utf-8').digest('hex');
				// transmit the authentication hash and a pjlink command
				self.socket.write(hex + "%1POWR ?\r");

				// Shoot and forget, by protocol definition :/
				if (typeof cb == 'function') {
					cb();
				}
			}

			if (self.commands.length) {
				var cmd = self.commands.shift();

				self.socket.write(self.passwordstring + cmd + "\r");
			} else {
				clearInterval(self.socketTimer);

				self.socketTimer = setInterval(function () {

					if (self.commands.length > 0) {
						var cmd = self.commands.shift();
						self.connect_time = Date.now();
						self.socket.write(self.passwordstring + cmd + "\r");
						clearInterval(self.socketTimer);
						delete self.socketTimer;
					}

					if (Date.now() - self.connect_time > 4000) {

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

			self.socket.write(self.passwordstring + cmd + "\r");
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
		'unfreeze':       { label: 'Unfreeze Input' },
		'inputToggle': {
			label: 'Switch Input',
			options: [
				{
					type: 'dropdown',
					label: 'Select input',
					id: 'inputNum',
					default: '31',
					choices: [
						{ id: '11', label: 'RGB1'},
						{ id: '12', label: 'RGB2' },
						{ id: '31', label: 'DVI-D'},
						{ id: '32', label: 'HDMI' },
						{ id: '33', label: 'Digital link' },
						{ id: '34', label: 'SDI1' },
						{ id: '35', label: 'SDI2' }
					]
				}
			]
		}
	});
};

instance.prototype.action = function(action) {
	var self = this;
	var id = action.action;
	var opt = action.options;
	var cmd

	switch (action.action){

		case 'powerOn':
			cmd = '%1POWR 1';
			break;

		case 'powerOff':
			cmd = '%1POWR 0';
			break;

		case 'shutterOpen':
			cmd = '%1AVMT 30';
			break;

		case 'shutterClose':
			cmd = '%1AVMT 31';
			break;

		case 'freeze':
			cmd = '%2FREZ 1';
			break;

		case 'unfreeze':
			cmd = '%2FREZ 0';
			break;

		case 'inputToggle':
			cmd = '%1INPT ' + opt.inputNum;
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
