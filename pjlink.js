/* eslint-disable no-useless-escape */
import { combineRgb, Regex, TCPHelper } from '@companion-module/base'
import { runEntrypoint, InstanceBase, InstanceStatus } from '@companion-module/base'
import crypto from 'crypto'
import * as CONFIG from './choices.js'
import { UpgradeScripts } from './upgrades.js'

function ar2obj(a) {
	return a.map((e, i) => ({ id: i, label: e }))
}

class PJInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	async init(config) {
		this.startup(config)
	}

	async configUpdated(config) {
		// stop everything and reset
		this.destroy(true)
		this.startup(config)
	}

	// When module gets deleted
	destroy(restart) {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.poll_interval !== undefined) {
			clearInterval(this.poll_interval)
			delete this.poll_interval
		}
		if (!restart) {
			this.log('debug', `Destroy ${this.id}`)
		}
	}

	startup(config) {
		this.config = config

		this.DebugLevel = process.env.DEVELOPER ? 2 : 0

		this.projector = {}
		this.projector.lamps = []

		for (let i = 1; i <= 8; i++) {
			this.projector.lamps.push({
				lamp: i,
				hours: '',
				on: 'off',
			})
		}
		// Laser projectors return an error when asking
		// for lamp hours
		this.projector.isLaser = false
		this.projector.freezeState = '0'
		this.projector.muteState = '00'

		this.projector.inputNames = CONFIG.INPUTS

		this.commands = []

		this.init_variables()
		this.init_feedbacks()
		this.buildActions() // export actions
		this.init_tcp()
	}

	check_auth(data, cb) {
		let code = []

		if ('PJLINK ERRA' == data) {
			this.log('error', 'Authentication error. Password not accepted by projector')
			this.commands.length = 0
			this.updateStatus(InstanceStatus.Error, 'Authentication error')
			this.pjConnected = false
			this.authOK = false
			this.passwordstring = ''
			this.socket.destroy()
			delete this.socket
			return
		} else if ('PJLINK 0' == data) {
			this.log('debug', 'Projector does not need password')
			this.passwordstring = ''
			this.authOK = true
		} else if ((code = data.match(/^PJLINK 1 (\S+)/))) {
			let digest = code[1] + this.config.password
			let hasher = crypto.createHash('md5')
			this.passwordstring = hasher.update(digest, 'utf-8').digest('hex')
			this.authOK = true
		}
		if (this.lastStatus != InstanceStatus.Ok + ';Auth') {
			this.updateStatus(InstanceStatus.Ok, 'Auth OK')
			this.lastStatus = InstanceStatus.Ok + ';Auth'
		}

		// send first command with (or without) auth password
		this.lastCmd = '%1POWR ?'
		this.socket?.send(this.passwordstring + this.lastCmd + '\r').then(() => {
			this.getProjectorDetails()
			if (this.poll_interval) {
				delete this.poll_interval
			}
			this.pollTime = this.config.pollTime ? this.config.pollTime * 1000 : 10000
			this.poll_interval = setInterval(this.poll.bind(this), this.pollTime) //ms for poll
			this.poll()
		})
		if (typeof cb == 'function') {
			cb()
		}
	}

	init_tcp(cb) {
		const self = this
		let receivebuffer = ''
		this.passwordstring = ''
		let args
		let cmd
		let err
		let resp
		let res
		let projClass

		if (this.socketTimer) {
			clearInterval(this.socketTimer)
			delete this.socketTimer
		}

		if (this.poll_interval) {
			clearInterval(this.poll_interval)
			delete this.poll_interval
		}

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.config.host) {
			this.authOK = true
			this.commands = []

			this.socket = new TCPHelper(this.config.host, 4352)

			this.socket.on('error', function (err) {
				if (self.lastStatus != InstanceStatus.Error + ';' + err.name) {
					self.updateStatus(InstanceStatus.Error, 'Network ' + err.message)
					self.lastStatus = InstanceStatus.Error + ';' + err.name
					self.log('error', 'Network ' + err.message)
				}
				self.pjConnected = false
				self.authOK = false
				this.commands = []
				// set timer to retry connection in 30 secs
				if (self.socketTimer) {
					clearInterval(self.socketTimer)
					delete self.socketTimer
				}
				delete self.socket
				self.socketTimer = setInterval(function () {
					self.updateStatus(InstanceStatus.ConnectionFailure, 'Retrying connection')
					self.init_tcp()
				}, 10000)
			})

			this.socket.on('connect', function () {
				receivebuffer = ''
				self.connect_time = Date.now()

				if (self.lastStatus != InstanceStatus.Ok) {
					self.updateStatus(InstanceStatus.Ok, 'Connected')
					self.log('info', 'Connected')
					self.lastStatus = InstanceStatus.Ok
				}
				self.pjConnected = true
				self.authOK = false
			})

			this.socket.on('end', function () {
				self.pjConnected = false
				self.authOK = false
				if (self.lastStatus != InstanceStatus.Error + ';Disc') {
					self.log('error', 'Projector Disconnected')
					self.updateStatus(InstanceStatus.Error, 'Disconnected')
					self.lastStatus = InstanceStatus.Error + ';Disc'
				}
				// set timer to retry connection in 30 secs
				if (self.socketTimer) {
					clearInterval(self.socketTimer)
					delete self.socketTimer
				}
				self.socketTimer = setInterval(function () {
					self.updateStatus(InstanceStatus.ConnectionFailure, 'Retrying connection')
					self.init_tcp()
				}, 30000)
				self.log('debug', 'Disconnected')
			})

			this.socket.on('data', function (chunk) {
				// separate buffered stream into lines with responses
				let i = 0,
					line = '',
					offset = 0
				receivebuffer += chunk
				while ((i = receivebuffer.indexOf('\r', offset)) !== -1) {
					line = receivebuffer.slice(offset, i)
					offset = i + 1
					self.socket?.emit('receiveline', line.toString())
				}
				receivebuffer = receivebuffer.slice(offset)
			})

			this.socket.on('receiveline', function (data) {
				self.connect_time = Date.now()

				if (self.DebugLevel > 1) {
					self.log('debug', `PJLINK: < ${data}`)
				}

				// auth password setup
				if (data.match(/^PJLINK*/i)) {
					self.check_auth(data, cb)
					return
				}

				if ((args = data.match(/^(%(\d).+)=ERR(\d)/i))) {
					let errorText = 'Unknown error'
					let newState = 'warn'
					let newStatus = InstanceStatus.UnknownWarning
					cmd = args[1].toUpperCase()
					projClass = parseInt(args[2])
					err = args[3].toUpperCase()

					switch (err) {
						case '1':
							if (cmd == '%1LAMP') {
								errorText = 'Projector reports no lamp, disabling lamp check for Laser'
								self.projector.isLaser = true
							} else {
								errorText =
									projClass === self.projector.class
										? 'Undefined command: ' + cmd
										: 'Command for different Protocol Class: ' + cmd
							}
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
							errorText = 'Projector Busy/Offline'
							break
						case '4':
							errorText = 'Projector/Display failure'
							newState = 'error'
							newStatus = InstanceStatus.Error
							break
					}
					if (cmd == '%2INNM') {
						// ignore. some PJ do not report input names
					} else {
						if (self.lastStatus != newStatus + ';' + err) {
							self.log(newState, errorText)
							self.updateStatus(newStatus, errorText)
							self.lastStatus = newStatus + ';' + err
						}
						self.log('debug', `PJLINK ERROR: ${errorText}`)
					}
				} else {
					let cmd = data.slice(0, 6).toUpperCase()
					let resp = data.slice(7) // leave case alone for labels
					// PJ returns 'OK' when command is accepted
					// we need the status response
					if ('OK' == resp) {
						return
					}

					switch (cmd) {
						case '%1CLSS':
							self.projector.class = resp
							self.setVariableValues({ projectorClass: resp })
							self.socket.emit('projectorClass')
							break
						case '%1NAME':
							self.projector.name = resp
							self.setVariableValues({ projectorName: resp })
							break
						case '%1INF1':
							self.projector.make = resp
							self.setVariableValues({ projectorMake: resp })
							break
						case '%1INF2':
							self.projector.model = resp
							self.setVariableValues({ projectorModel: resp })
							break
						case '%1INFO':
							self.projector.other = resp
							self.setVariableValues({ projectorOther: resp })
							break
						case '%2RLMP':
							self.projector.lampReplacement = resp
							self.setVariableValues({ lampReplacement: resp })
							break
						case '%2RFIL':
							self.projector.filterReplacement = resp
							self.setVariableValues({ filterReplacement: resp })
							break
						case '%1INST':
							self.projector.availInputs = resp.split(' ')
							// class 1 does not report names
							// so re-build a generic input list for this PJ
							let classCount = new Array(Object.keys(CONFIG.INPUT_CLASS).length).fill(0)
							self.projector.inputNames.length = 0
							for (let p of self.projector.availInputs) {
								let classNum = p[0]
								let inClass = CONFIG.INPUT_CLASS[classNum]
								classCount[classNum] += 1
								self.projector.inputNames.push({
									id: p,
									label: `${inClass}-${classCount[classNum]} (${p})`,
								})
							}
							self.updateActions = true
							break
						case '%2INST':
							self.projector.availInputs = resp.split(' ')
							// get input names from PJ
							self.getInputName(self.projector.availInputs)
							break
						case '%2INNM':
							if (self.projector.inputNames.length > self.haveNames) {
								let idx = self.projector.inputNames.findIndex((o) => o.label === null)
								let num = self.projector.inputNames[idx].id
								self.projector.inputNames[idx].label = `${resp} (${num})`
								self.haveNames += 1
								self.updateActions = self.projector.inputNames.length == self.haveNames
							}
							break
						case '%1POWR':
							self.projector.powerState = resp
							self.setVariableValues({ powerState: CONFIG.POWER_STATE[resp] })
							self.checkFeedbacks('powerState')
							// reset warining (if any)
							if (resp == '1' && self.lastStatus != InstanceStatus.Ok + ';Auth') {
								self.updateStatus(InstanceStatus.Ok, 'Auth OK')
								self.lastStatus = InstanceStatus.Ok + ';Auth'
							} else if (resp == '0' && self.lastStatus != InstanceStatus.Ok + ';Off') {
								self.updateStatus(InstanceStatus.Ok, 'PJ Standby')
								self.lastStatus = InstanceStatus.Ok + ';Off'
							} else if (resp == '2' && self.lastStatus != InstanceStatus.Ok + ';Cool') {
								self.updateStatus(InstanceStatus.Ok, 'PJ Cooling')
								self.lastStatus = InstanceStatus.Ok + ';Cool'
							} else if (resp == '3' && self.lastStatus != InstanceStatus.Ok + ';Warm') {
								self.updateStatus(InstanceStatus.Ok, 'PJ Warmup')
								self.lastStatus = InstanceStatus.Ok + ';Warm'
							}
							break
						case '%1INPT':
						case '%2INPT':
							let iName = self.projector.inputNames.find((o) => o.id == resp)?.label
							if (!iName) {
								iName = CONFIG.INPUT_CLASS[resp[0]] + ' (' + resp + ')'
								self.projector.inputNames.push({ id: resp, label: iName })
							}
							if (resp != self.projector.inputNum) {
								self.projector.inputNum = resp
								self.setVariableValues({ projectorInput: iName })
								self.checkFeedbacks('projectorInput')
								// only check input res when input changes
								if (cmd[1] == '2') {
									self.sendCmd('%2IRES ?')
								}
							}
							break
						case '%1LAMP':
							let stat = resp.split(' ')
							for (let i = 0; i < stat.length; i += 2) {
								let thisLamp = Math.floor(i / 2)
								let lampHours = stat[i]
								let onState = stat[i + 1] == '1' ? 'On' : 'Off'
								self.projector.lamps[thisLamp] = { lamp: thisLamp, hours: lampHours, on: onState }
								self.setVariableValues({
									[`lamp${thisLamp + 1}Hrs`]: lampHours,
									[`lamp${thisLamp + 1}On`]: onState,
								})
							}
							// fill table for unused lamps
							for (let i = stat.length; i < 16; i += 2) {
								let thisLamp = Math.floor(i / 2)
								self.projector.lamps[thisLamp] = { lamp: thisLamp, hours: 0, on: 'Off' }
								self.setVariableValues({
									[`lamp${thisLamp + 1}Hrs`]: '',
									[`lamp${thisLamp + 1}On`]: 'N/A',
								})
							}
							self.checkFeedbacks('lampHour')
							break
						case '%2IRES':
							res = resp.split('x')
							self.projector.inputHorzRes = res[0]
							self.projector.inputVertRes = res[1]
							self.setVariableValues({
								inputHorzRes: res[0],
								inputVertRes: res[1],
							})
							break
						case '%2RRES':
							res = resp.split('x')
							self.projector.recHorzRes = res[0]
							self.projector.recVertRes = res[1]
							self.setVariableValues({
								recHorzRes: res[0],
								recVertRes: res[1],
							})
							break
						case '%1ERST':
							const errs = resp.split('')
							self.projector.errorFan = errs[0]
							self.projector.errorLamp = errs[1]
							self.projector.errorTemp = errs[2]
							self.projector.errorCover = errs[3]
							self.projector.errorFilter = errs[4]
							self.projector.errorOther = errs[5]
							self.setVariableValues({
								errorFan: CONFIG.ERROR_STATE[errs[0]],
								errorLamp: CONFIG.ERROR_STATE[errs[1]],
								errorTemp: CONFIG.ERROR_STATE[errs[2]],
								errorCover: CONFIG.ERROR_STATE[errs[3]],
								errorFilter: CONFIG.ERROR_STATE[errs[4]],
								errorOther: CONFIG.ERROR_STATE[errs[5]],
							})
							self.checkFeedbacks('errors')
							break
						case '%1AVMT':
							self.projector.muteState = resp
							let tmp = CONFIG.MUTE_ITEM[resp[0]]
							tmp = tmp + ' ' + CONFIG.ON_OFF_STATE[resp[1]]
							self.setVariableValues({ muteState: tmp })
							self.checkFeedbacks('muteState')
							break
						case '%2FREZ':
							self.projector.freezeState = resp
							self.setVariableValues({ freezeState: CONFIG.ON_OFF_STATE[resp] })
							self.checkFeedbacks('freezeState')
							break
						case '%2SNUM':
							self.projector.serialNumber = resp
							self.setVariableValues({ serialNumber: resp })
							break
						case '%2SVER':
							self.projector.softwareVer = resp
							self.setVariableValues({ softwareVer: resp })
							break
						case '%2FILT':
							self.projector.filterUsageTime = resp
							self.setVariableValues({ filterUsageTime: resp })
							break
					}
				}

				if (self.commands.length) {
					if (self.lastCmd != data.slice(0,6)) {
						self.log('debug', `Response mismatch, expected ${self.lastCmd}`)
					}
					let nextCmd = self.commands.shift()
					if (self.DebugLevel >= 1) {
						self.log('debug', `PJLINK: > ${nextCmd}`)
					}
					self.lastCmd = nextCmd.slice(0, 6)
					self.socket.send(self.passwordstring + nextCmd + '\r')
				} else {
					if (self.socketTimer) {
						clearInterval(self.socketTimer)
						delete self.socketTimer
					}

					self.socketTimer = setInterval(function () {
						if (self.commands.length > 0) {
							let cmd = self.commands.shift()
							self.connect_time = Date.now()
							self.lastCmd = cmd.slice(0, 6)
							self.socket.send(self.passwordstring + cmd + '\r')
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
							self.pjConnected = false
							self.authOK = false

							self.log('debug', 'disconnecting per protocol defintion :(')
						}
					}, 100)
				}
			})

			self.socket.connect()
		}
	}

	async sendCmd(cmd) {
		let self = this

		if (this.DebugLevel >= 1) {
			this.log('debug', `PJLINK(send): > ${cmd}`)
		}
		if (this.DebugLevel >= 2) {
			if (this.commands.length > 0) {
				this.log('debug', `this.commands is ${this.commands}`)
			}
		}

		if (!this.authOK) {
			if (!(cmd in this.commands)) {
				this.commands.push(cmd)
			}
		} else if (this.pjConnected) {
			try {
				await this.socket.send(this.passwordstring + cmd + '\r')
			} catch (error) {
				// connected but not ready :/
				if (error.code == 'EPIPE') {
					this.commands.push(cmd)
				}
			}
		} else {
			if (!(cmd in this.commands)) {
				this.commands.push(cmd)
			}
		}
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				regex: Regex.IP,
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

	/**
	 * Setup actions for this module
	 *
	 * @since 2.0.0
	 */
	buildActions() {
		let actions = {
			powerState: {
				name: 'Change Projector Power State',
				options: [
					{
						type: 'dropdown',
						label: 'Select Power State',
						id: 'opt',
						default: '1',
						choices: ar2obj(CONFIG.ON_OFF_TOGGLE),
					},
				],
			},
			muteState: {
				name: 'Change Projector Mute State ',
				options: [
					{
						type: 'dropdown',
						label: 'Select Mute',
						id: 'item',
						default: '3',
						choices: ar2obj(CONFIG.MUTE_ITEM),
					},
					{
						type: 'dropdown',
						label: 'Select State',
						id: 'opt',
						default: '0',
						choices: ar2obj(CONFIG.ON_OFF_TOGGLE),
					},
				],
			},
			freezeState: {
				name: 'Change Projector Freeze State',
				options: [
					{
						type: 'dropdown',
						label: 'Select Freeze State',
						id: 'opt',
						default: '0',
						choices: ar2obj(CONFIG.ON_OFF_TOGGLE),
					},
				],
			},
			inputToggle: {
				name: 'Switch Projector Input',
				options: [
					{
						type: 'dropdown',
						label: 'Select input',
						id: 'inputNum',
						//default: this.projector.inputNames[0],
						choices: this.projector.inputNames,
					},
				],
			},
		}
		for (let cmd in actions) {
			actions[cmd].callback = async (action, context) => {
				this.doAction(action)
			}
		}
		this.setActionDefinitions(actions)
	}

	doAction(action) {
		let opt = action.options
		let cmd = null

		function setToggle(curVal, opt) {
			return 2 == parseInt(opt) ? 1 - parseInt(curVal) : parseInt(opt)
		}

		switch (action.actionId) {
			case 'powerState':
				// don't send if warming/cooling
				if ('01'.includes(this.projector.powerState)) {
					cmd = '%1POWR ' + setToggle(this.projector.powerState, opt.opt)
				}
				break

			case 'muteState':
				cmd = '%1AVMT '
				// toggle
				if ('2' == opt.opt) {
					var was = opt.item & (this.projector.muteState[0] * this.projector.muteState[1])
					cmd += opt.item + (was == 0 ? '1' : '0')
				} else {
					// simple on/off
					cmd += opt.item + opt.opt
				}
				break

			case 'freezeState':
				cmd = '%2FREZ ' + setToggle(this.projector.freezeState, opt.opt)
				break

			case 'inputToggle':
				cmd = '%1INPT ' + opt.inputNum
				break
		}

		if (cmd !== null) {
			if (this.DebugLevel >= 1) {
				this.log('debug', `sending ${cmd} to ${this.config.host}`)
			}

			// reset warining (if any)
			if (this.lastStatus != InstanceStatus.Ok + ';Auth') {
				this.updateStatus(InstanceStatus.Ok, 'Auth OK')
				this.lastStatus = InstanceStatus.Ok + ';Auth'
			}

			this.sendCmd(cmd)
			// follow up with a status update

			this.sendCmd(cmd.slice(0, 7) + '?')
		}

		// log('debug','action():', action);
	}

	init_variables() {
		var variables = []

		variables.push({
			name: 'Projector Class',
			variableId: 'projectorClass',
		})

		variables.push({
			name: 'Projector Name',
			variableId: 'projectorName',
		})

		variables.push({
			name: 'Projector Manufacturer',
			variableId: 'projectorMake',
		})

		variables.push({
			name: 'Projector Product Name',
			variableId: 'projectorModel',
		})

		variables.push({
			name: 'Projector Other Info',
			variableId: 'projectorOther',
		})

		variables.push({
			name: 'Error Status - Fan',
			variableId: 'errorFan',
		})

		variables.push({
			name: 'Error Status - Lamp',
			variableId: 'errorLamp',
		})

		variables.push({
			name: 'Error Status - Temp',
			variableId: 'errorTemp',
		})

		variables.push({
			name: 'Error Status - Cover',
			variableId: 'errorCover',
		})

		variables.push({
			name: 'Error Status - Filter',
			variableId: 'errorFilter',
		})

		variables.push({
			name: 'Error Status - Other',
			variableId: 'errorOther',
		})

		variables.push({
			name: 'Freeze Status',
			variableId: 'freezeState',
		})

		variables.push({
			name: 'Input Horizontal Resolution',
			variableId: 'inputHorzRes',
		})

		variables.push({
			name: 'Recommended Vertical Resolution',
			variableId: 'recVertRes',
		})

		variables.push({
			name: 'Recommended Horizontal Resolution',
			variableId: 'recHorzRes',
		})

		variables.push({
			name: 'Input Vertical Resolution',
			variableId: 'inputVertRes',
		})

		variables.push({
			name: 'Lamp 1 Hours',
			variableId: 'lamp1Hrs',
		})

		variables.push({
			name: 'Lamp 2 Hours',
			variableId: 'lamp2Hrs',
		})

		variables.push({
			name: 'Lamp 3 Hours',
			variableId: 'lamp3Hrs',
		})

		variables.push({
			name: 'Lamp 4 Hours',
			variableId: 'lamp4Hrs',
		})

		variables.push({
			name: 'Lamp 5 Hours',
			variableId: 'lamp5Hrs',
		})

		variables.push({
			name: 'Lamp 6 Hours',
			variableId: 'lamp6Hrs',
		})

		variables.push({
			name: 'Lamp 7 Hours',
			variableId: 'lamp7Hrs',
		})

		variables.push({
			name: 'Lamp 8 Hours',
			variableId: 'lamp8Hrs',
		})

		variables.push({
			name: 'Lamp 1 On',
			variableId: 'lamp1On',
		})

		variables.push({
			name: 'Lamp 2 On',
			variableId: 'lamp2On',
		})

		variables.push({
			name: 'Lamp 3 On',
			variableId: 'lamp3On',
		})

		variables.push({
			name: 'Lamp 4 On',
			variableId: 'lamp4On',
		})

		variables.push({
			name: 'Lamp 5 On',
			variableId: 'lamp5On',
		})

		variables.push({
			name: 'Lamp 6 On',
			variableId: 'lamp6On',
		})

		variables.push({
			name: 'Lamp 7 On',
			variableId: 'lamp7On',
		})

		variables.push({
			name: 'Lamp 8 On',
			variableId: 'lamp8On',
		})

		variables.push({
			name: 'Serial Number',
			variableId: 'serialNumber',
		})

		variables.push({
			name: 'Software Version',
			variableId: 'softwareVer',
		})

		variables.push({
			name: 'Filter Usage Time',
			variableId: 'filterUsageTime',
		})

		variables.push({
			name: 'Filter Replacment Model Number',
			variableId: 'filterReplacement',
		})

		variables.push({
			name: 'Lamp Replacment Model Number',
			variableId: 'lampReplacement',
		})

		variables.push({
			name: 'Mute Status',
			variableId: 'muteState',
		})

		variables.push({
			name: 'Projector Power Status',
			variableId: 'powerState',
		})

		variables.push({
			name: 'Projector Input',
			variableId: 'projectorInput',
		})

		this.setVariableDefinitions(variables)
		this.setVariableValues({
			freezeState: 'N/A',
			serialNumber: 'N/A',
			softwareVer: 'N/A',
			lampReplacement: 'N/A',
			filterReplacement: 'N/A',
			filterUsageTime: 'N/A',
			inputHorzRes: 'N/A',
			inputVertRes: 'N/A',
			recHorzRes: 'N/A',
			recVertRes: 'N/A',
		})
	}

	init_feedbacks() {
		let self = this

		const feedbacks = {
			errors: {
				type: 'boolean',
				name: 'Change colors based on Error status',
				description: 'Change colors based on Error status',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(200, 0, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: 'Error',
						id: 'error',
						default: 'errorFan',
						choices: CONFIG.ERROR_TYPES,
					},
					{
						type: 'dropdown',
						label: 'Status',
						id: 'errorState',
						default: '0',
						choices: ar2obj(CONFIG.ERROR_STATE),
					},
				],
				callback: (feedback, context) => {
					return this.projector[feedback.options.error] === feedback.options.errorState
				},
			},
			freezeState: {
				type: 'boolean',
				name: 'Change colors based on Freeze status',
				description: 'Change colors based on Freeze status',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 200, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: 'Status',
						id: 'freezeState',
						default: '0',
						choices: ar2obj(CONFIG.ON_OFF_STATE),
					},
				],
				callback: (feedback, context) => {
					return this.projector.freezeState === feedback.options.freezeState
				},
			},
			lampHour: {
				type: 'boolean',
				name: 'Change colors based on Lamp hours greater than hours',
				description: 'Change colors based on Lamp hours greater than hours',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 200, 0),
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
				callback: (feedback, context) => {
					return this.projector.lamps[feedback.options.lamp].hours > feedback.options.lampHour
				},
			},
			muteState: {
				type: 'boolean',
				name: 'Change colors based on Mute status',
				description: 'Change colors based on Mute status',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 200, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: 'Mute item',
						id: 'item',
						default: '3',
						choices: ar2obj(CONFIG.MUTE_ITEM),
					},
					{
						type: 'dropdown',
						label: 'Status',
						id: 'opt',
						default: '1',
						choices: ar2obj(CONFIG.ON_OFF_STATE),
					},
				],
				callback: (feedback, context) => {
					// A/V is 'open' only if both are open
					// A is open either A or A/V
					// V is open either V or A/V
					let item = self.projector.muteState[0] & feedback.options.item ? 1 : 0
					let stat = self.projector.muteState[1] == feedback.options.opt ? 1 : 0
					return stat == item
				},
			},
			projectorInput: {
				type: 'boolean',
				name: 'Change colors based on Projector Input',
				description: 'Change colors based on Projector Input',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 200, 0),
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
				callback: (feedback, context) => {
					return self.projector.inputNum === feedback.options.inputNum
				},
			},
			powerState: {
				type: 'boolean',
				name: 'Change colors based on Power status',
				description: 'Change colors based on Power status',
				style: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 200, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: 'Status',
						id: 'powerState',
						default: '0',
						choices: ar2obj(CONFIG.POWER_STATE),
					},
				],
				callback: (feedback, context) => {
					return self.projector.powerState === feedback.options.powerState
				},
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	getProjectorDetails() {
		var self = this

		//Query Projector Class
		this.sendCmd('%1CLSS ?')

		//Projector Class dependant initial queries
		this.socket.on('projectorClass', function () {
			//any class

			//Query Projector Name
			self.sendCmd('%1NAME ?')
			//Query Projector Manufacturer
			self.sendCmd('%1INF1 ?')
			//Query Projector Product Name
			self.sendCmd('%1INF2 ?')
			//Query Projector Product Name
			self.sendCmd('%1INFO ?')

			self.sendCmd(`%${self.projector.class}INST ?`)

			if (self.projector.class === '2') {
				//Query Serial Number
				self.sendCmd('%2SNUM ?')
				//Query Software Version
				self.sendCmd('%2SVER ?')
				//Query Lamp Replacement
				self.sendCmd('%2RLMP ?')
				//Query Filter Replacement
				self.sendCmd('%2RFIL ?')
				//Query Recommended Resolution
				self.sendCmd('%2RRES ?')
			}
		})
	}

	poll() {
		let self = this
		let checkHours = false

		// re-connect?
		if (!this.pjConnected) {
			this.init_tcp()
			return
		}
		// wait for class response before sending status requests
		if (this.projector.class === undefined) {
			return
		}

		// first time or every 10 minutes
		if (this.lastHours === undefined || Date.now() - this.lastHours > 600000) {
			checkHours = true
			this.lastHours = Date.now()
		}

		// got full list of input names from PJ, update action dropdown
		if (this.updateActions) {
			this.buildActions() // reload actions
			this.updateActions = false // only need once
		}
		//Query Power
		this.sendCmd('%1POWR ?')
		//Query Error Status
		this.sendCmd('%1ERST ?')

		//Query Lamp
		// -- I was going to add this to the 10 minute check
		// -- but the response includes the lamp on status
		// Laser PJ does not have a 'lamp'
		if (!this.projector.isLaser) {
			this.sendCmd('%1LAMP ?')
		}

		//Query Mute Status and input (only valid if PJ is on)
		if (this.projector.powerState == '1') {
			this.sendCmd('%1AVMT ?')
			this.sendCmd(`%${this.projector.class}INPT ?`)
		}

		//Class 2 Queries
		if (this.projector.class === '2') {
			//Query Freeze Status (only if PJ is on)
			if (this.projector.powerState == '1') {
				this.sendCmd('%2FREZ ?')
			}
			//Query Filter Usage
			if (checkHours) {
				this.sendCmd('%2FILT ?')
			}
		}

		// log('debug','this.projector is', this.projector)
	}

	getInputName(inputs) {
		var self = this
		// class 2 names the inputs, so start with an empty list
		this.projector.inputNames = []
		this.haveNames = 0
		for (const element of inputs) {
			this.projector.inputNames.push({ id: element, label: null })
			this.sendCmd('%2INNM ?' + element)
		}
	}
}
runEntrypoint(PJInstance, UpgradeScripts)
