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

	self.commands = []
	//self.projector.class = '1'

	self.status(self.STATUS_UNKNOWN, 'Connecting')
	self.init_tcp()
	self.init_variables()
	self.init_feedbacks()
}

instance.prototype.init_tcp = function (cb) {
	var self = this
	var receivebuffer = ''
	self.passwordstring = ''
	var match

	if (self.socketTimer) {
		clearInterval(self.socketTimer)
		delete self.socketTimer
	}

	if (self.poll_interval) {
		clearInterval(self.poll_interval)
	}

	if (self.socket !== undefined) {
		self.socket.destroy()
		delete self.socket
	}

	if (self.config.host) {
		self.connecting = true
		self.commands = []

		self.socket = new net.Socket()
		self.socket.setNoDelay(true)

		self.socket.on('error', function (err) {
			debug('Network error', err)
			self.status(self.STATE_ERROR, err)
			self.log('error', 'Network error: ' + err.message)
			self.connected = false
			self.connecting = false
			delete self.socket
		})

		self.socket.on('connect', function () {
			receivebuffer = ''
			self.connect_time = Date.now()

			if (self.currentStatus != self.STATUS_OK) {
				self.status(self.STATUS_OK, 'Connected')
				debug('Connected to projector')
			}
			self.getProjectorDetails()
			self.pollTime = self.config.pollTime ? self.config.pollTime * 1000 : 10000
			self.poll_interval = setInterval(self.poll.bind(self), self.pollTime) //ms for poll
			self.poll()

			self.connected = true
		})

		self.socket.on('end', function () {
			self.connected = false
			self.connecting = false
			debug('Disconnected')
		})

		self.socket.on('data', function (chunk) {
			// separate buffered stream into lines with responses
			var i = 0,
				line = '',
				offset = 0
			receivebuffer += chunk
			while ((i = receivebuffer.indexOf('\r', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset)
				offset = i + 1
				self.socket.emit('receiveline', line.toString())
			}
			receivebuffer = receivebuffer.substr(offset)
		})

		self.socket.on('receiveline', function (data) {
			self.connect_time = Date.now()

			debug('PJLINK: < ', data)

			if (data.match(/^PJLINK ERRA/)) {
				debug('Password not accepted')
				self.log('error', 'Authentication error. Password not accepted by projector')
				self.commands.length = 0
				self.status(self.STATUS_ERROR, 'Authentication error')
				self.connected = false
				self.connecting = false
				self.socket.destroy()
				delete self.socket
				return
			}

			if (data.match(/^PJLINK 0/)) {
				debug('Projector does not need password')
				self.passwordstring = ''

				// no auth
				if (typeof cb == 'function') {
					cb()
				}
			}

			if ((match = data.match(/^(%(\d).+)=ERR(\d)/))) {
				cmd = match[1]
				projClass = match[2]
				err = match[3]

				switch (err) {
					case '1':
						{
							errorText =
								projClass === self.projector.class
									? 'Undefined command: ' + cmd
									: 'Command for different Project Class: ' + cmd
							self.log('error', errorText)
							debug('PJLINK ERROR: ', errorText)
						}
						break
					case '2':
						{
							self.log('error', cmd + ' Out of parameter')
							debug('PJLINK ERROR: ', cmd + ' Out of parameter')
						}
						break
					case '3':
						{
							self.log('error', 'Unavailable time')
							debug('PJLINK ERROR: Unavailable time')
						}
						break
					case '4':
						{
							self.log('error', 'Projector/Display failure')
							debug('PJLINK ERROR: Projector/Display failure')
						}
						break
				}
				return
			}

			if ((match = data.match(/^%1CLSS=(\d)/))) {
				self.projector.class = match[1]
				self.setVariable('projectorClass', self.projector.class)
				self.socket.emit('projectorClass')
				//self.checkFeedbacks('projectorClass')
			}

			if ((match = data.match(/^%1NAME=(.+)/))) {
				self.projector.name = match[1]
				self.setVariable('projectorName', self.projector.name)
			}

			if ((match = data.match(/^%1INF1=(.+)/))) {
				self.projector.make = match[1]
				self.setVariable('projectorMake', self.projector.make)
			}

			if ((match = data.match(/^%1INF2=(.+)/))) {
				self.projector.model = match[1]
				self.setVariable('projectorModel', self.projector.model)
			}

			if ((match = data.match(/^%1INFO=(.+)/))) {
				self.projector.other = match[1]
				self.setVariable('projectorOther', self.projector.other)
			}

			if ((match = data.match(/^%2RLMP=(.+)/))) {
				self.projector.lampReplacement = match[1]
				self.setVariable('lampReplacement', self.projector.lampReplacement)
			}

			if ((match = data.match(/^%1INST=(.+)/))) {
				self.projector.availInputs = match[1].split(' ')
			}

			if ((match = data.match(/^%2INST=(.+)/))) {
				self.projector.availInputs = match[1].split(' ')

				self.getInputName(self.projector.availInputs)
			}

			if ((match = data.match(/^%2INNM=(.+)/))) {
				if (!(match[1] === 'ERR1' || match[1] === 'ERR2' || match[1] === 'ERR3')) {
					idx = self.projector.inputNames.findIndex((o) => o.label === null)
					self.projector.inputNames[idx].label = match[1]
				}
			}

			if ((match = data.match(/^%1POWR=(\d)/))) {
				self.projector.powerState = match[1]
				self.setVariable('powerState', CONFIG_POWER_STATE.find((o) => o.id == self.projector.powerState)?.label)
				self.checkFeedbacks('powerState')
			}

			if ((match = data.match(/^%\dINPT=(\d+)/))) {
				self.projector.inputNum = match[1]
				self.setVariable(
					'projectorInput',
					self.projector.inputNames.find((o) => o.id == self.projector.inputNum)?.label
				)
				self.checkFeedbacks('projectorInput')
			}

			if ((match = data.match(/^%1LAMP=(.+)/))) {
				var response = match[1].match(/(\d+.\d)/g)
				response.forEach((element, index) => {
					hours = element.split(' ')[0]
					on = element.split(' ')[1] === '1' ? 'On' : 'Off'
					self.projector.lamps[index] = { lamp: index + 1, hours: hours, on: on }
				})
				self.projector.lamps.forEach((element, index) => {
					self.setVariable('lamp' + [index + 1] + 'Hrs', element.hours)
					self.setVariable('lamp' + [index + 1] + 'On', element.on)
				})
				self.checkFeedbacks('lampHour')
			}

			if ((match = data.match(/^%2IRES=(\d+)x(\d+)/))) {
				self.projector.inputHorzRes = match[1]
				self.projector.inputVertRes = match[2]
				self.setVariable('inputHorzRes', self.projector.inputHorzRes)
				self.setVariable('inputVertRes', self.projector.inputVertRes)
			}

			if ((match = data.match(/^%2RRES=(\d+)x(\d+)/))) {
				self.projector.recHorzRes = match[1]
				self.projector.recVertRes = match[2]
				self.setVariable('recHorzRes', self.projector.recHorzRes)
				self.setVariable('recVertRes', self.projector.recVertRes)
			}

			if ((match = data.match(/^%1ERST=(\d)(\d)(\d)(\d)(\d)(\d)/))) {
				self.projector.errorFan = match[1]
				self.projector.errorLamp = match[2]
				self.projector.errorTemp = match[3]
				self.projector.errorCover = match[4]
				self.projector.errorFilter = match[5]
				self.projector.errorOther = match[6]
				self.setVariable('errorFan', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorFan)?.label)
				self.setVariable('errorLamp', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorLamp)?.label)
				self.setVariable('errorTemp', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorTemp)?.label)
				self.setVariable('errorCover', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorCover)?.label)
				self.setVariable('errorFilter', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorFilter)?.label)
				self.setVariable('errorOther', CONFIG_ERROR_STATE.find((o) => o.id == self.projector.errorOther)?.label)
				self.checkFeedbacks('errors')
			}

			if ((match = data.match(/^%1AVMT=(\d+)/))) {
				self.projector.muteState = match[1]
				self.setVariable('muteState', CONFIG_MUTE_STATE.find((o) => o.id == self.projector.muteState)?.label)
				self.checkFeedbacks('muteState')
			}

			if ((match = data.match(/^%2FREZ=(\d+)/))) {
				self.projector.freezeState = match[1]
				self.setVariable('freezeState', CONFIG_FREEZE_STATE.find((o) => o.id == self.projector.freezeState)?.label)
				self.checkFeedbacks('freezeState')
			}

			if ((match = data.match(/^%2SNUM=(.+)/))) {
				self.projector.serialNumber = match[1]
				self.setVariable('serialNumber', self.projector.serialNumber)
			}

			if ((match = data.match(/^%2SVER=(.+)/))) {
				self.projector.softwareVer = match[1]
				self.setVariable('softwareVer', self.projector.softwareVer)
			}

			if ((match = data.match(/^%2FILT=(.+)/))) {
				self.projector.filterUsageTime = match[1]
				self.setVariable('filterUsageTime', self.projector.filterUsageTime)
			}

			if ((match = data.match(/^PJLINK 1 (\S+)/))) {
				var digest = match[1] + self.config.password
				var hasher = crypto.createHash('md5')
				var hex = hasher.update(digest, 'utf-8').digest('hex')
				// transmit the authentication hash and a pjlink command
				self.socket.write(hex + '%1POWR ?\r')

				// Shoot and forget, by protocol definition :/
				if (typeof cb == 'function') {
					cb()
				}
			}

			if (self.commands.length) {
				var cmd = self.commands.shift()

				self.socket.write(self.passwordstring + cmd + '\r')
			} else {
				clearInterval(self.socketTimer)

				self.socketTimer = setInterval(function () {
					if (self.commands.length > 0) {
						var cmd = self.commands.shift()
						self.connect_time = Date.now()
						self.socket.write(self.passwordstring + cmd + '\r')
						clearInterval(self.socketTimer)
						delete self.socketTimer
					}

					if (Date.now() - self.connect_time > 4000) {
						if (self.socket !== undefined && self.socket.destroy !== undefined) {
							self.socket.destroy()
						}

						delete self.socket
						self.connected = false
						self.connecting = false

						if (self.socketTimer) {
							clearInterval(self.socketTimer)
							delete self.socketTimer
						}

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

	debug('PJLINK: > ', cmd)

	if (self.connecting) {
		self.commands.push(cmd)
	} else {
		self.init_tcp(function () {
			self.connect_time = Date.now()

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
		debug('sending ', cmd, 'to', self.config.host)

		self.send(cmd)
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
				default: 'Off',
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

	//Query Projector Name
	self.send('%1NAME ?')
	//Query Projector Manufacturer
	self.send('%1INF1 ?')
	//Query Projector Product Name
	self.send('%1INF2 ?')
	//Query Projector Product Name
	self.send('%1INFO ?')
	//Query Input List
	self.send('%1INST ?')

	//Projector Class dependant initial queries
	self.socket.on('projectorClass', function () {
		if (self.projector.class === '2') {
			//Query Input List
			self.send('%2INST ?')
			//Query Serial Number
			self.send('%2SNUM ?')
			//Query Software Version
			self.send('%2SVER ?')
			//Query Lamp Replacement
			self.send('%2RLMP ?')
			//Query Filter Replacement
			self.send('%2RFIL ?')
		}
	})
}

instance.prototype.poll = function () {
	var self = this

	//Query Power
	self.send('%1POWR ?')
	//Query Lamp
	self.send('%1LAMP ?')
	//Query Error Status
	self.send('%1ERST ?')
	//Query Mute Status
	self.send('%1AVMT ?')

	//Query Input
	self.projector.class === '2' ? self.send('%2INPT ?') : self.send('%1INPT ?')

	//Class 2 Queries
	if (self.projector.class === '2') {
		//Query Input Resolution
		self.send('%2IRES ?')
		//Query Recommended Resolution
		self.send('%2RRES ?')
		//Query Freeze Status
		self.send('%2FREZ ?')
		//Query Filter Usage
		self.send('%2FILT ?')
	}

	self.actions() // reload actions
	debug('self.projector is', self.projector)
}

instance.prototype.getInputName = function (inputs) {
	var self = this
	self.projector.inputNames = []
	for (const element of inputs) {
		self.projector.inputNames.push({ id: element, label: null })
		self.send('%2INNM ?' + element)
	}
}

instance_skel.extendedBy(instance)
exports = module.exports = instance
