'use strict'
var net = require('net')
var instance_skel = require('../../instance_skel')
var crypto = require('crypto')
const upgradescripts = require('./upgrades')
var debug
var log

const CONFIG_ERRORS = [
	{ id: 'errorFan', label: 'Fan' },
	{ id: 'errorLamp', label: 'Lamp' },
	{ id: 'errorTemp', label: 'Temp' },
	{ id: 'errorCover', label: 'Cover' },
	{ id: 'errorFilter', label: 'Filter' },
	{ id: 'errorOther', label: 'Other' },
]

const CONFIG_ERROR_STATE = [
	{ id: '0', label: 'No Error' },
	{ id: '1', label: 'Warning' },
	{ id: '2', label: 'Error' },
]

const SHOW_ERROR_STATE = [
	'No Error',
	'Warning',
	'Error'
]

const CONFIG_FREEZE_STATE = [
	{ id: '0', label: 'Off' },
	{ id: '1', label: 'On' },
]

const CONFIG_INPUTS = [
	{ id: '11', label: 'RGB1' },
	{ id: '12', label: 'RGB2' },
	{ id: '31', label: 'DVI-D' },
	{ id: '32', label: 'HDMI' },
	{ id: '33', label: 'Digital link' },
	{ id: '34', label: 'SDI1' },
	{ id: '35', label: 'SDI2' },
	{ id: '52', label: 'LAN' },
	{ id: '56', label: 'HDBaseT' },
]

const CONFIG_INPUT_CLASS = {
	'1': 'RGB',
	'2': 'Video' ,
	'3': 'Digital' ,
	'4': 'Storage' ,
	'5': 'Network' ,
	'6': 'Internal',
}

const CONFIG_MUTE_STATE = [
	{ id: '11', label: 'Video mute On' },
	{ id: '21', label: 'Audio Mute On' },
	{ id: '30', label: 'A/V mute Off' },
	{ id: '31', label: 'A/V mute On' },
]

const CONFIG_POWER_STATE = [
	{ id: '0', label: 'Off' },
	{ id: '1', label: 'On' },
	{ id: '2', label: 'Cooling' },
	{ id: '3', label: 'Warm-up' },
]

function instance(system, id, config) {
	var self = this

	// super-constructor
	instance_skel.apply(this, arguments)
	self.projector = []
	self.projector.lamps = []

	for (let i = 1; i <= 8; i++) {
		self.projector.lamps.push({
			lamp: i,
			hours: '0',
			on: 'off',
		})
	}

	self.projector.inputNames = CONFIG_INPUTS

	self.actions() // export actions

	return self
}

instance.GetUpgradeScripts = function () {
	return [upgradescripts.upgrade_choices]
}

instance.prototype.updateConfig = function (config) {
	var self = this

	self.config = config
	self.init_variables()
	self.init_feedbacks()
	self.init_tcp()
}

instance.prototype.init = function () {
	var self = this

	debug = self.debug
	log = self.log

	self.DebugLevel = 0


	self.commands = []
	//self.projector.class = '1'

	self.status(self.STATUS_WARNING, 'Connecting')
	self.init_tcp()
	self.init_variables()
	self.init_feedbacks()
}

instance.prototype.check_auth = function(data, cb) {
	var self = this
	var match

	if ('PJLINK ERRA' == data) {
		debug('Password not accepted')
		self.log('error', 'Authentication error. Password not accepted by projector')
		self.commands.length = 0
		self.status(self.STATUS_ERROR, 'Authentication error')
		self.connected = false
		self.authOK = false
		self.passwordstring = ''
		self.socket.destroy()
		delete self.socket
		return
	} else if ('PJLINK 0' == data) {
		debug('Projector does not need password')
		self.passwordstring = ''
		self.authOK = true
	} else if (match = data.match(/^PJLINK 1 (\S+)/)) {
		var digest = match[1] + self.config.password
		var hasher = crypto.createHash('md5')
		self.passwordstring = hasher.update(digest, 'utf-8').digest('hex')
		self.authOK = true
	}
	if (self.lastStatus != self.STATUS_OK + ';Auth') {
		self.status(self.STATUS_OK, 'Auth OK')
		self.lastStatus = self.STATUS_OK + ';Auth'
	}

	// send first command with (or without) auth password
	self.lastCmd = '%1POWR ?'
	self.socket?.write(self.passwordstring + self.lastCmd + '\r')

	self.getProjectorDetails()
	self.pollTime = self.config.pollTime ? self.config.pollTime * 1000 : 10000
	self.poll_interval = setInterval(self.poll.bind(self), self.pollTime) //ms for poll
	self.poll()

	if (typeof cb == 'function') {
		cb()
	}
}

instance.prototype.init_tcp = function (cb) {
	var self = this
	var receivebuffer = ''
	self.passwordstring = ''
	var match
	var cmd
	var err
	var resp
	var projClass

	if (self.socketTimer) {
		clearInterval(self.socketTimer)
		delete self.socketTimer
	}

	if (self.poll_interval) {
		clearInterval(self.poll_interval)
		delete self.poll_interval
	}

	if (self.socket !== undefined) {
		self.socket.destroy()
		delete self.socket
	}

	if (self.config.host) {
		self.authOK = true
		self.commands = []

		self.socket = new net.Socket()
		self.socket.setNoDelay(true)

		self.socket.on('error', function (err) {
			debug('Network ', err)
			if (self.lastStatus != self.STATUS_ERROR + ';' + err.name) {
				self.status(self.STATUS_ERROR, 'Network ' + err.message)
				self.lastStatus = self.STATUS_ERROR + ';' + err.name
				self.log('error', 'Network ' + err.message)
			}
			self.connected = false
			self.authOK = false
			delete self.socket
			// set timer to retry connection in 30 secs
			if (self.socketTimer) {
				clearInterval(self.socketTimer)
				delete self.socketTimer
			}
			self.socketTimer = setInterval(function() {
					self.status(self.STATUS_ERROR,'Retrying connection')
					self.init_tcp()
				}, 30000)
		})

		self.socket.on('connect', function () {
			receivebuffer = ''
			self.connect_time = Date.now()

			if (self.lastStatus != self.STATUS_OK) {
				self.status(self.STATUS_OK, 'Connected')
				self.log('info','Connected')
				debug('Connected to projector')
				self.lastStatus = self.STATUS_OK
			}
			self.connected = true
			self.authOK = false

		})

		self.socket.on('end', function () {
			self.connected = false
			self.authOK = false
			if (self.lastStatus != self.STATUS_ERROR + ';Disc') {
				self.log('error','Projector Disconnected')
				self.status(self.STATUS_ERROR, 'Disconnected')
				self.lastStatus = self.STATUS_ERROR + ';Disc'
			}
			// set timer to retry connection in 30 secs
			if (self.socketTimer) {
				clearInterval(self.socketTimer)
				delete self.socketTimer
			}
			self.socketTimer = setInterval(function() {
				self.status(self.STATUS_ERROR,'Retrying connection')
				self.init_tcp()
			}, 30000)
			debug('Disconnected')
		})

		self.socket.on('data', function (chunk) {
			// separate buffered stream into lines with responses
			var i = 0,
				line = '',
				offset = 0
			receivebuffer += chunk
			while ((i = receivebuffer.indexOf('\r', offset)) !== -1) {
				line = receivebuffer.slice(offset, i )
				offset = i + 1
				self.socket?.emit('receiveline', line.toString())
			}
			receivebuffer = receivebuffer.slice(offset)
		})

		self.socket.on('receiveline', function (data) {

			self.connect_time = Date.now()

			if (self.DebugLevel>1) {
				debug('PJLINK: < ' , data)
			}

			// auth password setup
			if (data.match(/^PJLINK*/)) {
				self.check_auth(data,cb)
				return
			}

			if ((match = data.match(/^(%(\d).+)=ERR(\d)/))) {
				var errorText = 'Unknown error'
				var newState = 'warn'
				var newStatus = self.STATUS_WARNING
				cmd = match[1]
				projClass = match[2]
				err = match[3]

				switch (err) {
					case '1':
						errorText =
							projClass === self.projector.class
								? 'Undefined command: ' + cmd
								: 'Command for different Protocol Class: ' + cmd
						break
					case '2':
						errorText = 'Projector reported ' + cmd
						if (cmd.slice(2) == 'INPT') {
							errorText += ': No such input'
						} else {
							errorText += ': Out of parameter'
						}
						break
					case '3':
						if (self.projector.powerState == '0') {
							errorText = `Command '${cmd}' unavailable. Projector in standby.`
						} else {
							errorText = 'Projector Unavailable time. Command was ' + cmd
						}
						break
					case '4':
						errorText = 'Projector/Display failure'
						newState = 'error'
						newStatus = self.STATUS_ERROR
						break
				}
				if (self.lastStatus != newStatus + ';' + err) {
					self.log(newState, errorText)
					self.status(newStatus, errorText)
					self.lastStatus = newStatus + ';' + err
				}
				debug('PJLINK ERROR: ', errorText)
				cmd = data.slice(0,6)
			} else {
				cmd = data.slice(0,6)
				resp = data.slice(7)

				switch (cmd) {
					case '%1CLSS':
						self.projector.class = resp
						self.setVariable('projectorClass', resp)
						self.socket.emit('projectorClass')
						break
					case '%1NAME':
						self.projector.name = resp
						self.setVariable('projectorName', resp)
						break
					case '%1INF1':
						self.projector.make = resp
						self.setVariable('projectorMake', resp)
						break
					case '%1INF2':
						self.projector.model = resp
						self.setVariable('projectorModel', resp)
						break
					case '%1INFO':
						self.projector.other = resp
						self.setVariable('projectorOther', resp)
						break
					case '%2RLMP':
						self.projector.lampReplacement = resp
						self.setVariable('lampReplacement', resp)
						break
					case '%2RFIL':
						self.projector.filterRepacement = resp
						self.setVariable('filterReplacement',resp)
						break
					case '%1INST':
					case '%2INST':
						self.projector.availInputs = resp.split(' ')
						if (cmd.slice(1,2) == '2') {
							self.getInputName(self.projector.availInputs)
						}
						break
					case '%2INNM':
						switch (resp) {
							case 'ERR1':
							case 'ERR2':
							case 'ERR3':
								break
							default:
								var idx = self.projector.inputNames.findIndex((o) => o.label === null)
								self.projector.inputNames[idx].label = resp
								self.haveNames += 1
								self.updateActions = self.projector.inputNames.length == self.haveNames
						}
						break
					case '%1POWR':
						self.projector.powerState = resp
						self.setVariable('powerState',CONFIG_POWER_STATE.find((o) => o.id == resp)?.label)
						self.checkFeedbacks('powerState')
						// reset warining (if any)
						if (resp == '1' && self.lastStatus != self.STATUS_OK + ';Auth') {
							self.status(self.STATUS_OK, 'Auth OK')
							self.lastStatus = self.STATUS_OK + ';Auth'
						}
						break
					case '%1INPT':
					case '%2INPT':
						// PJ returns 'OK' when input is switched
						if ('OK' == resp) {
							return
						}
						var iName = self.projector.inputNames.find((o) => o.id == resp)?.label
						if (!iName) {
							iName = CONFIG_INPUT_CLASS[resp[0]] + resp[1]
							self.projector.inputNames.push({id: resp, label: iName })
						}
						if (resp != self.projector.inputNum) {
							self.projector.inputNum = resp
							self.setVariable('projectorInput',iName)
							self.checkFeedbacks('projectorInput')
							// only check input res when input changes
							if (cmd.slice(1,2) == '2') {
								self.send('%2IRES ?')
							}
						}
						break
					case '%1LAMP':
						var stat = resp.split(' ')
						for (let i = 0; i < stat.length; i += 2) {
							var thisLamp = Math.floor(i / 2)
							var lampHours = stat[i]
							var onState = (stat[i+1] == '1' ? 'On': 'Off')
							self.projector.lamps[thisLamp] = {lamp: thisLamp, hours: lampHours, on: onState}
							self.setVariable('lamp' + (thisLamp + 1) + 'Hrs', lampHours)
							self.setVariable('lamp' + (thisLamp + 1) + 'On', onState)
						}
						// fill table for unused lamps
						for (let i = stat.length; i < 16; i += 2) {
							var thisLamp = Math.floor(i / 2)
							self.projector.lamps[thisLamp] = { lamp: thisLamp, hours: 0, on: 'Off' }
							self.setVariable('lamp' + (thisLamp + 1) + 'Hrs', 0)
							self.setVariable('lamp' + (thisLamp + 1) + 'On', 'Off')
						}
						self.checkFeedbacks('lampHour')
						break
					case '%2IRES':
						var res = resp.split('x')
						self.projector.inputHorzRes = res[0]
						self.projector.inputVertRes = res[1]
						self.setVariable('inputHorzRes', res[0])
						self.setVariable('inputVertRes', res[1])
						break
					case '%2RRES':
						var res = resp.split('x')
						self.projector.recHorzRes = res[0]
						self.projector.recVertRes = res[1]
						self.setVariable('recHorzRes', res[0])
						self.setVariable('recVertRes', res[1])
						break
					case '%1ERST':
						var errs = resp.split('')
						self.projector.errorFan = errs[0]
						self.projector.errorLamp = errs[1]
						self.projector.errorTemp = errs[2]
						self.projector.errorCover = errs[3]
						self.projector.errorFilter = errs[4]
						self.projector.errorOther = errs[5]
						self.setVariable('errorFan', SHOW_ERROR_STATE[errs[0]])
						self.setVariable('errorLamp', SHOW_ERROR_STATE[errs[1]])
						self.setVariable('errorTemp', SHOW_ERROR_STATE[errs[2]])
						self.setVariable('errorCover', SHOW_ERROR_STATE[errs[3]])
						self.setVariable('errorFilter', SHOW_ERROR_STATE[errs[4]])
						self.setVariable('errorOther', SHOW_ERROR_STATE[errs[5]])
						self.checkFeedbacks('errors')
						break
					case '%1AVMT':
						self.projector.muteState = resp
						self.setVariable('muteState', CONFIG_MUTE_STATE.find((o) => o.id == resp)?.label)
						self.checkFeedbacks('muteState')
						break
					case '%2FREZ':
						self.projector.freezeState = resp
						self.setVariable('freezeState', CONFIG_FREEZE_STATE.find((o) => o.id == resp)?.label)
						self.checkFeedbacks('freezeState')
						break
					case '%2SNUM':
						self.projector.serialNumber = resp
						self.setVariable('serialNumber', resp)
						break
					case '%2SVER':
						self.projector.softwareVer = resp
						self.setVariable('softwareVer', resp)
						break
					case '%2FILT':
						self.projector.filterUsageTime = resp
						self.setVariable('filterUsageTime', resp)
						break
				}
			}

			if (self.commands.length) {
				if (self.lastCmd != cmd) {
					debug (`Response mismatch, expected ${self.lastCmd}`)
				}
				var nextCmd = self.commands.shift()
				if (self.DebugLevel >= 1) {
					debug('PJLINK: > ' + nextCmd)
				}
				self.lastCmd = nextCmd.slice(0,6)
				self.socket.write(self.passwordstring + nextCmd + '\r')
			} else {
				if (self.socketTimer) {
					clearInterval(self.socketTimer)
					delete self.socketTimer
				}

				self.socketTimer = setInterval(function () {
					if (self.commands.length > 0) {
						var cmd = self.commands.shift()
						self.connect_time = Date.now()
						self.lastCmd = cmd.slice(0,6)
						self.socket.write(self.passwordstring + cmd + '\r')
						clearInterval(self.socketTimer)
						delete self.socketTimer
					}

					// istnv: an old version of the documentation stated 4 seconds.
					//		Reading through version 1.04 and version 2.00,
					//		idle time is 30 seconds

					if (Date.now() - self.connect_time > 30000) {

						if (self.socketTimer) {
							clearInterval(self.socketTimer)
							delete self.socketTimer
						}
						if (self.socket !== undefined && self.socket.destroy !== undefined) {
							self.socket.destroy()
						}

						delete self.socket
						self.connected = false
						self.authOK = false

						debug('disconnecting per protocol defintion :(')
					}
				}, 100)
			}
		})

		self.socket.connect(4352, self.config.host)

	}

}

instance.prototype.send = function (cmd) {
	var self = this

	if (self.DebugLevel >= 1) {
		debug('PJLINK(send): > ', cmd)
	}
	if (self.DebugLevel >= 2) {
		debug('self.commands is', self.commands)
	}

	if (!self.authOK) {
		self.commands.push(cmd)
	} else if (self.connected) {
		self.socket.write(self.passwordstring + cmd + '\r')
	} else {
			self.init_tcp(function () {
			self.connect_time = Date.now()
			self.lastCmd = cmd.slice(0,6)

			self.socket.write(self.passwordstring + cmd + '\r')
		})
	}
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 6,
			regex: self.REGEX_IP,
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'PJLink password (empty for none)',
			width: 6,
		},
		{
			type: 'number',
			id: 'pollTime',
			label: 'Enter polling time in seconds',
			default: 10,
		},
	]
}

// When module gets deleted
instance.prototype.destroy = function () {
	var self = this

	if (self.socket !== undefined) {
		self.socket.destroy()
		delete self.socket
	}

	if (self.poll_interval !== undefined) {
		clearInterval(self.poll_interval)
		delete self.poll_interval
	}
	debug('destroy', self.id)
}

instance.prototype.actions = function (system) {
	var self = this

	self.setActions({
		powerState: {
			label: 'Change Projector Power State',
			options: [
				{
					type: 'dropdown',
					label: 'Select Power State',
					id: 'opt',
					default: '1',
					choices: CONFIG_POWER_STATE.slice(0, 2),
				},
			],
		},
		muteState: {
			label: 'Change Projector Mute State ',
			options: [
				{
					type: 'dropdown',
					label: 'Select Mute State',
					id: 'opt',
					default: '30',
					choices: CONFIG_MUTE_STATE,
				},
			],
		},
		freezeState: {
			label: 'Change Projector Freeze State',
			options: [
				{
					type: 'dropdown',
					label: 'Select Mute State',
					id: 'opt',
					default: '0',
					choices: CONFIG_FREEZE_STATE,
				},
			],
		},
		inputToggle: {
			label: 'Switch Projector Input',
			options: [
				{
					type: 'dropdown',
					label: 'Select input',
					id: 'inputNum',
					//default: self.projector.inputNames[0],
					choices: self.projector.inputNames,
				},
			],
		},
	})
}

instance.prototype.action = function (action) {
	var self = this
	var id = action.action
	var opt = action.options
	var cmd

	switch (action.action) {
		case 'powerState':
			cmd = '%1POWR ' + opt.opt
			break

		case 'muteState':
			cmd = '%1AVMT ' + opt.opt
			break

		case 'freezeState':
			cmd = '%2FREZ ' + opt.opt
			break

		case 'inputToggle':
			cmd = '%1INPT ' + opt.inputNum
			break
	}

	if (cmd !== undefined) {
		if (self.DebugLevel >= 1) {
			debug('sending ', cmd, 'to', self.config.host)
		}

		// reset warining (if any)
		if (self.lastStatus != self.STATUS_OK + ';Auth') {
			self.status(self.STATUS_OK, 'Auth OK')
			self.lastStatus = self.STATUS_OK + ';Auth'
		}

		self.send(cmd)
		// follow up with a status update

		self.send(cmd.slice(0,7) + '?')
	}

	// debug('action():', action);
}

instance.prototype.init_variables = function () {
	var self = this
	var variables = []

	variables.push({
		label: 'Projector Class',
		name: 'projectorClass',
	})

	variables.push({
		label: 'Projector Name',
		name: 'projectorName',
	})

	variables.push({
		label: 'Projector Manufacturer',
		name: 'projectorMake',
	})

	variables.push({
		label: 'Projector Product Name',
		name: 'projectorModel',
	})

	variables.push({
		label: 'Projector Other Info',
		name: 'projectorOther',
	})

	variables.push({
		label: 'Error Status - Fan',
		name: 'errorFan',
	})

	variables.push({
		label: 'Error Status - Lamp',
		name: 'errorLamp',
	})

	variables.push({
		label: 'Error Status - Temp',
		name: 'errorTemp',
	})

	variables.push({
		label: 'Error Status - Cover',
		name: 'errorCover',
	})

	variables.push({
		label: 'Error Status - Filter',
		name: 'errorFilter',
	})

	variables.push({
		label: 'Error Status - Other',
		name: 'errorOther',
	})

	variables.push({
		label: 'Freeze Status',
		name: 'freezeState',
	})

	variables.push({
		label: 'Input Horizontal Resolution',
		name: 'inputHorzRes',
	})

	variables.push({
		label: 'Recommended Vertical Resolution',
		name: 'recVertRes',
	})

	variables.push({
		label: 'Recommended Horizontal Resolution',
		name: 'recHorzRes',
	})

	variables.push({
		label: 'Input Vertical Resolution',
		name: 'inputVertRes',
	})

	variables.push({
		label: 'Lamp 1 Hours',
		name: 'lamp1Hrs',
	})

	variables.push({
		label: 'Lamp 2 Hours',
		name: 'lamp2Hrs',
	})

	variables.push({
		label: 'Lamp 3 Hours',
		name: 'lamp3Hrs',
	})

	variables.push({
		label: 'Lamp 4 Hours',
		name: 'lamp4Hrs',
	})

	variables.push({
		label: 'Lamp 5 Hours',
		name: 'lamp5Hrs',
	})

	variables.push({
		label: 'Lamp 6 Hours',
		name: 'lamp6Hrs',
	})

	variables.push({
		label: 'Lamp 7 Hours',
		name: 'lamp7Hrs',
	})

	variables.push({
		label: 'Lamp 8 Hours',
		name: 'lamp8Hrs',
	})

	variables.push({
		label: 'Lamp 1 On',
		name: 'lamp1On',
	})

	variables.push({
		label: 'Lamp 2 On',
		name: 'lamp2On',
	})

	variables.push({
		label: 'Lamp 3 On',
		name: 'lamp3On',
	})

	variables.push({
		label: 'Lamp 4 On',
		name: 'lamp4On',
	})

	variables.push({
		label: 'Lamp 5 On',
		name: 'lamp5On',
	})

	variables.push({
		label: 'Lamp 6 On',
		name: 'lamp6On',
	})

	variables.push({
		label: 'Lamp 7 On',
		name: 'lamp7On',
	})

	variables.push({
		label: 'Lamp 8 On',
		name: 'lamp8On',
	})

	variables.push({
		label: 'Serial Number',
		name: 'serialNumber',
	})

	variables.push({
		label: 'Software Version',
		name: 'softwareVer',
	})

	variables.push({
		label: 'Filter Usage Time',
		name: 'filterUsageTime',
	})

	variables.push({
		label: 'Filter Replacment Model Number',
		name: 'filterReplacement',
	})

	variables.push({
		label: 'Lamp Replacment Model Number',
		name: 'lampReplacement',
	})

	variables.push({
		label: 'Mute Status',
		name: 'muteState',
	})

	variables.push({
		label: 'Projector Power Status',
		name: 'powerState',
	})

	variables.push({
		label: 'Projector Input',
		name: 'projectorInput',
	})

	self.setVariableDefinitions(variables)
}

instance.prototype.init_feedbacks = function () {
	var self = this
	var feedbacks = {}

	feedbacks['errors'] = {
		type: 'boolean',
		label: 'Change colors based on Error status',
		description: 'Change colors based on Error status',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(200, 0, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Error',
				id: 'error',
				default: 'errorFan',
				choices: CONFIG_ERRORS,
			},
			{
				type: 'dropdown',
				label: 'Status',
				id: 'errorState',
				default: '0',
				choices: CONFIG_ERROR_STATE,
			},
		],
	}

	feedbacks['freezeState'] = {
		type: 'boolean',
		label: 'Change colors based on Freeze status',
		description: 'Change colors based on Freeze status',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(0, 200, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Status',
				id: 'freezeState',
				default: '0',
				choices: CONFIG_FREEZE_STATE,
			},
		],
	}

	feedbacks['lampHour'] = {
		type: 'boolean',
		label: 'Change colors based on Lamp hours greater than hours',
		description: 'Change colors based on Lamp hours greater than hours',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(0, 200, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Lamp',
				id: 'lamp',
				default: '1',
				choices: [
					{ id: '1', label: 'Lamp 1' },
					{ id: '2', label: 'Lamp 2' },
					{ id: '3', label: 'Lamp 3' },
					{ id: '4', label: 'Lamp 4' },
					{ id: '5', label: 'Lamp 5' },
					{ id: '6', label: 'Lamp 6' },
					{ id: '7', label: 'Lamp 7' },
					{ id: '8', label: 'Lamp 8' },
				],
			},
			{
				type: 'number',
				label: 'Greater than Hours',
				id: 'lampHour',
				default: 10000,
				min: 0,
			},
		],
	}

	feedbacks['muteState'] = {
		type: 'boolean',
		label: 'Change colors based on Mute status',
		description: 'Change colors based on Mute status',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(0, 200, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Status',
				id: 'muteState',
				default: '31',
				choices: CONFIG_MUTE_STATE,
			},
		],
	}

	feedbacks['projectorInput'] = {
		type: 'boolean',
		label: 'Change colors based on Projector Input',
		description: 'Change colors based on Projector Input',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(0, 200, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Select input',
				id: 'inputNum',
				default: '31',
				choices: self.projector.inputNames,
			},
		],
	}

	feedbacks['powerState'] = {
		type: 'boolean',
		label: 'Change colors based on Power status',
		description: 'Change colors based on Power status',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(0, 200, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Status',
				id: 'powerState',
				default: '0',
				choices: CONFIG_POWER_STATE,
			},
		],
	}

	self.setFeedbackDefinitions(feedbacks)
}

instance.prototype.feedback = function (feedback) {
	var self = this

	if (feedback.type === 'errors') {
		switch (feedback.options.error) {
			case 'errorFan':
				if (self.projector.errorFan === feedback.options.errorState) {
					return true
				}
				break
			case 'errorLamp':
				if (self.projector.errorLamp === feedback.options.errorState) {
					return true
				}
				break
			case 'errorTemp':
				if (self.projector.errorTemp === feedback.options.errorState) {
					return true
				}
				break
			case 'errorCover':
				if (self.projector.errorCover === feedback.options.errorState) {
					return true
				}
				break
			case 'errorFilter':
				if (self.projector.errorFilter === feedback.options.errorState) {
					return true
				}
				break
			case 'errorOther':
				if (self.projector.errorOther === feedback.options.errorState) {
					return true
				}
				break
		}
	}

	if (feedback.type === 'freezeState') {
		if (self.projector.freezeState === feedback.options.freezeState) {
			return true
		}
	}

	if (feedback.type === 'lampHour') {
		if (self.projector.lamps.find((o) => o.lamp == feedback.options.lamp).hours > feedback.options.lampHour) {
			return true
		}
	}

	if (feedback.type === 'muteState') {
		if (self.projector.muteState === feedback.options.muteState) {
			return true
		}
	}

	if (feedback.type === 'powerState') {
		if (self.projector.powerState === feedback.options.powerState) {
			return true
		}
	}

	if (feedback.type === 'projectorInput') {
		if (self.projector.inputNum === feedback.options.inputNum) {
			return true
		}
	}

	return false
}

instance.prototype.getProjectorDetails = function () {
	var self = this

	//Query Projector Class
	self.send('%1CLSS ?')

	//Projector Class dependant initial queries
	self.socket.on('projectorClass', function () {

		//any class

		//Query Projector Name
		self.send('%1NAME ?')
		//Query Projector Manufacturer
		self.send('%1INF1 ?')
		//Query Projector Product Name
		self.send('%1INF2 ?')
		//Query Projector Product Name
		self.send('%1INFO ?')

		self.send(`%${self.projector.class}INST ?`)

		if (self.projector.class === '2') {
			//Query Serial Number
			self.send('%2SNUM ?')
			//Query Software Version
			self.send('%2SVER ?')
			//Query Lamp Replacement
			self.send('%2RLMP ?')
			//Query Filter Replacement
			self.send('%2RFIL ?')
			//Query Recommended Resolution
			self.send('%2RRES ?')
		}

	})
}

instance.prototype.poll = function () {
	var self = this
	var checkHours = false

	// re-connect?
	if (!self.connected) {
		self.init_tcp()
		return
	}
	// wait for class response before sending status requests
	if (self.projector.class === undefined)  {
		return
	}

	// first time or every 10 minutes
	if (self.lastHours===undefined || Date.now() - self.lastHours > 600000) {
		checkHours = true
		self.lastHours = Date.now()
	}

	// class 2 got full list of input names from PJ
	if (self.updateActions) {
		self.actions() // reload actions
	}
	//Query Power
	self.send('%1POWR ?')
	//Query Error Status
	self.send('%1ERST ?')
	//Query Lamp
	// -- I was going to add this to the 10 minute check
	// -- but the response includes the lamp on status
	self.send('%1LAMP ?')

	//Query Mute Status and input (only valid if PJ is on)
	if (self.projector.powerState == '1') {
		self.send('%1AVMT ?')
		self.send(`%${self.projector.class}INPT ?`)
	}

	//Class 2 Queries
	if (self.projector.class === '2') {
		//Query Freeze Status (only if PJ is on)
		if (self.projector.powerState == '1') {
			self.send('%2FREZ ?')
		}
		//Query Filter Usage
		if (checkHours) {
			self.send('%2FILT ?')
		}
	}

	// debug('self.projector is', self.projector)
}

instance.prototype.getInputName = function (inputs) {
	var self = this
	// class 2 names the inputs, so start with an empty list
	self.projector.inputNames = []
	self.haveNames = 0
	for (const element of inputs) {
		self.projector.inputNames.push({ id: element, label: null })
		self.send('%2INNM ?' + element)
	}
}

instance_skel.extendedBy(instance)
exports = module.exports = instance
