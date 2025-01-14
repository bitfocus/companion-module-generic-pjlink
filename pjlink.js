/* eslint-disable no-useless-escape */
import { combineRgb, Regex, TCPHelper } from '@companion-module/base'
import { runEntrypoint, InstanceBase, InstanceStatus } from '@companion-module/base'
import crypto from 'crypto'
import * as CONFIG from './choices.js'
import { UpgradeScripts } from './upgrades.js'

function ar2obj(a) {
	return a.map((e, i) => ({ id: `${i}`, label: e }))
}

function stamp() {
	const d = new Date()
	return `${d.getMinutes()}:${d.getSeconds()}.${d.getMilliseconds()}`
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

		if (this.restartTimer !== undefined) {
			clearInterval(this.restartTimer)
			delete this.restartTimer
		}

		if (!restart) {
			this.log('debug', `Destroy ${this.id}`)
		}
	}

	startup(config) {
		this.config = config

		this.DebugLevel = process.env.DEVELOPER || this.config.debug ? 2 : 0

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
		this.badPassword = false
		this.projector.freezeState = '0'
		this.projector.muteState = '00'

		this.projector.inputNames = CONFIG.INPUTS
		this.needInputs = true

		this.commands = []

		this.init_variables()
		this.init_feedbacks()
		this.buildActions() // export actions
		this.init_tcp()
	}

	check_auth(data, cb) {
		let code = []
    let restart = 15000

		if ('PJLINK ERRA' == data.toUpperCase()) {
			if ('ok' == this.lastStatus.split(';')[0]) {
				//projector reset its own digest
        restart = 1000
			} else if (this.lastStatus != InstanceStatus.ConnectionFailure + ';Auth') {
				this.log('error', 'Authentication error. Password not accepted by projector')
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Authentication error')
				this.lastStatus = InstanceStatus.ConnectionFailure + ';Auth'
        restart = 15000
			}
			this.commands.length = 0
			this.pjConnected = false
			this.badPassword = true
			this.authOK = false
			this.passwordstring = ''
			if (this.socket) {
				this.socket.destroy()
			}
			delete this.socket
			this.restartSocket(restart)
		} else {
			if ('PJLINK 0' == data.toUpperCase()) {
				this.log('debug', 'Projector does not need password')
				this.passwordstring = ''
				this.authOK = true
			} else if ((code = data.match(/^PJLINK 1 (\S+)/i))) {
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
		}
		if (typeof cb == 'function') {
			cb()
		}
	}

	restartSocket(waitTime = 5000) {
		if (this.restartTimer) {
			clearInterval(this.restartTimer)
			delete this.restartTimer
		}

		this.restartTimer = setInterval(() => {
			// don't restart if connected
			if (this.socket === undefined || !this.socket.isConnected) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Retrying connection')
				this.init_tcp()
			}
		}, waitTime)
	}

	init_tcp(cb) {
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
			const port = this.config.port || 4352

			this.socket = new TCPHelper(this.config.host, port)

			this.socket.on('error', (err) => {
				if (err.code == 'EPIPE') {
					// not really connected, yet
					return
				}
				if (this.lastStatus != InstanceStatus.Error + ';' + err.name) {
					this.updateStatus(InstanceStatus.Error, 'Network ' + err.message)
					this.lastStatus = InstanceStatus.Error + ';' + err.name
					this.log('error', 'Network ' + err.message)
				}
				this.pjConnected = false
				this.authOK = false
				this.commands = []
				if (this.socketTimer) {
					clearInterval(this.socketTimer)
					delete this.socketTimer
				}

				if (this.socket !== undefined && this.socket.destroy !== undefined) {
					this.socket.destroy()
					delete this.socket
				}
				this.restartSocket()
			})

			this.socket.on('connect', () => {
				receivebuffer = ''
				this.connect_time = Date.now()

				if (this.lastStatus != InstanceStatus.Connecting) {
					this.updateStatus(InstanceStatus.Connecting, 'Authorizing')
					this.log('info', 'Authorizing')
					this.lastStatus = InstanceStatus.Connecting
				}
				this.pjConnected = true
				if (this.restartTimer !== undefined) {
					clearInterval(this.restartTimer)
					delete this.restartTimer
				}
				this.authOK = false
			})

			this.socket.on('end', () => {
				this.pjConnected = false
				this.authOK = false
				if (this.lastStatus != InstanceStatus.Error + ';Disc') {
					this.log('error', 'Projector Disconnected')
					this.updateStatus(InstanceStatus.Error, 'Disconnected')
					this.lastStatus = InstanceStatus.Error + ';Disc'
				}
				// set timer to retry connection in 30 secs
				if (this.socketTimer) {
					clearInterval(this.socketTimer)
					delete this.socketTimer
				}
				if (this.socket !== undefined && this.socket.destroy !== undefined) {
					this.socket.destroy()
					delete this.socket
				}
				this.log('debug', 'Disconnected')
				this.restartSocket()
			})

			this.socket.on('data', (chunk) => {
				// separate buffered stream into lines with responses
				let i = 0,
					line = '',
					offset = 0
				receivebuffer += chunk
				while ((i = receivebuffer.indexOf('\r', offset)) !== -1) {
					line = receivebuffer.slice(offset, i)
					offset = i + 1
					this.socket?.emit('receiveline', line.toString())
				}
				receivebuffer = receivebuffer.slice(offset)
			})

			this.socket.on('receiveline', async (data) => {
				this.connect_time = Date.now()

				if (this.DebugLevel > 1) {
					this.log('debug', `PJLINK: < ${stamp()} ${data}`)
				}

				// auth password setup
				if (data.match(/^PJLINK*/i)) {
					this.check_auth(data, cb)
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
								this.projector.isLaser = true
							} else {
								if (projClass === this.projector.class) {
									errorText = 'Undefined command: ' + cmd
								} else {
									errorText = 'Command for different Protocol Class: ' + cmd
									// downgrade to Class 1
									this.projector.class = 1
								}
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
					if (cmd == '%2INNM' || (this.projector.powerState != '1' && err == '3')) {
						// ignore. some PJ do not report input names
					} else {
						if (this.lastStatus != newStatus + ';' + err) {
							this.log(newState, errorText)
							this.updateStatus(newStatus, errorText)
							this.lastStatus = newStatus + ';' + err
						}
						this.log('debug', `PJLINK ERROR: ${errorText}`)
					}
				} else if (data.match(/^PJLINK*/i)) {
					// auth password setup
					this.check_auth(data, cb)
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
							this.projector.class = resp
							this.setVariableValues({ projectorClass: resp })
							this.socket.emit('projectorClass')
							break
						case '%1NAME':
							this.projector.name = resp
							this.setVariableValues({ projectorName: resp })
							break
						case '%1INF1':
							this.projector.make = resp
							this.setVariableValues({ projectorMake: resp })
							break
						case '%1INF2':
							this.projector.model = resp
							this.setVariableValues({ projectorModel: resp })
							break
						case '%1INFO':
							this.projector.other = resp
							this.setVariableValues({ projectorOther: resp })
							break
						case '%2RLMP':
							this.projector.lampReplacement = resp
							this.setVariableValues({ lampReplacement: resp })
							break
						case '%2RFIL':
							this.projector.filterReplacement = resp
							this.setVariableValues({ filterReplacement: resp })
							break
						case '%1INST':
							this.projector.availInputs = resp.split(' ')
							// class 1 does not report names
							// so re-build a generic input list for this PJ
							let classCount = new Array(Object.keys(CONFIG.INPUT_CLASS).length).fill(0)
							this.projector.inputNames.length = 0
							for (let p of this.projector.availInputs) {
								let classNum = p[0]
								let inClass = CONFIG.INPUT_CLASS[classNum]
								classCount[classNum] += 1
								this.projector.inputNames.push({
									id: p,
									label: `${inClass}-${classCount[classNum]} (${p})`,
								})
							}
							this.updateActions = true
							this.needInputs = false
							break
						case '%2INST':
							this.needInputs = false
							this.projector.availInputs = resp.split(' ')
							// get input names from PJ
							this.getInputName(this.projector.availInputs)
							break
						case '%2INNM':
							if (this.projector.inputNames.length > this.haveNames) {
								let idx = this.projector.inputNames.findIndex((o) => o.label === null)
								let num = this.projector.inputNames[idx].id
								this.projector.inputNames[idx].label = `${resp} (${num})`
								this.haveNames += 1
								this.updateActions = this.projector.inputNames.length == this.haveNames
							}
							break
						case '%1POWR':
							let powerTransition = this.projector.powerState + resp
							this.badPassword = false
							this.projector.powerState = resp
							this.setVariableValues({ powerState: CONFIG.POWER_STATE[resp] })
							this.checkFeedbacks('powerState')
							// reset warining (if any)
							if (resp == '1' && this.lastStatus != InstanceStatus.Ok + ';Auth') {
								this.updateStatus(InstanceStatus.Ok, 'Auth OK')
								this.lastStatus = InstanceStatus.Ok + ';Auth'
							} else if (resp == '0' && this.lastStatus != InstanceStatus.Ok + ';Off') {
								this.updateStatus(InstanceStatus.Ok, 'PJ Standby')
								this.lastStatus = InstanceStatus.Ok + ';Off'
							} else if (resp == '2' && this.lastStatus != InstanceStatus.Ok + ';Cool') {
								this.updateStatus(InstanceStatus.Ok, 'PJ Cooling')
								this.lastStatus = InstanceStatus.Ok + ';Cool'
							} else if (resp == '3' && this.lastStatus != InstanceStatus.Ok + ';Warm') {
								this.updateStatus(InstanceStatus.Ok, 'PJ Warmup')
								this.lastStatus = InstanceStatus.Ok + ';Warm'
							}
							// PJ went from off/warm to powered on, initial Query Mute Status and input
							if (['01', '31'].includes(powerTransition)) {
								this.sendCmd('%1AVMT ?')
								this.sendCmd(`%${this.projector.class}INPT ?`)
							}
							break
						case '%1INPT':
						case '%2INPT':
							let iName = this.projector.inputNames.find((o) => o.id == resp)?.label
							if (!iName) {
								iName = CONFIG.INPUT_CLASS[resp[0]] + ' (' + resp + ')'
								this.projector.inputNames.push({ id: resp, label: iName })
							}
							if (resp != this.projector.inputNum) {
								this.projector.inputNum = resp
								this.setVariableValues({ projectorInput: iName })
								this.checkFeedbacks('projectorInput')
								// only check input res when input changes
								if (cmd[1] == '2') {
									this.sendCmd('%2IRES ?')
								}
							}
							break
						case '%1LAMP':
							let stat = resp.split(' ')
							for (let i = 0; i < stat.length; i += 2) {
								let thisLamp = Math.floor(i / 2)
								let lampHours = stat[i]
								let onState = stat[i + 1] == '1' ? 'On' : 'Off'
								this.projector.lamps[thisLamp] = { lamp: thisLamp, hours: lampHours, on: onState }
								this.setVariableValues({
									[`lamp${thisLamp + 1}Hrs`]: lampHours,
									[`lamp${thisLamp + 1}On`]: onState,
								})
							}
							// fill table for unused lamps
							for (let i = stat.length; i < 16; i += 2) {
								let thisLamp = Math.floor(i / 2)
								this.projector.lamps[thisLamp] = { lamp: thisLamp, hours: 0, on: 'Off' }
								this.setVariableValues({
									[`lamp${thisLamp + 1}Hrs`]: '',
									[`lamp${thisLamp + 1}On`]: 'N/A',
								})
							}
							this.checkFeedbacks('lampHour')
							break
						case '%2IRES':
							res = resp.split('x')
							this.projector.inputHorzRes = res[0]
							this.projector.inputVertRes = res[1]
							this.setVariableValues({
								inputHorzRes: res[0],
								inputVertRes: res[1],
							})
							break
						case '%2RRES':
							res = resp.split('x')
							this.projector.recHorzRes = res[0]
							this.projector.recVertRes = res[1]
							this.setVariableValues({
								recHorzRes: res[0],
								recVertRes: res[1],
							})
							break
						case '%1ERST':
							const errs = resp.split('')
							this.projector.errorFan = errs[0]
							this.projector.errorLamp = errs[1]
							this.projector.errorTemp = errs[2]
							this.projector.errorCover = errs[3]
							this.projector.errorFilter = errs[4]
							this.projector.errorOther = errs[5]
							this.setVariableValues({
								errorFan: CONFIG.ERROR_STATE[errs[0]],
								errorLamp: CONFIG.ERROR_STATE[errs[1]],
								errorTemp: CONFIG.ERROR_STATE[errs[2]],
								errorCover: CONFIG.ERROR_STATE[errs[3]],
								errorFilter: CONFIG.ERROR_STATE[errs[4]],
								errorOther: CONFIG.ERROR_STATE[errs[5]],
							})
							this.checkFeedbacks('errors')
							break
						case '%1AVMT':
							this.projector.muteState = resp
							let tmp = CONFIG.MUTE_ITEM[resp[0]]
							tmp = tmp + ' ' + CONFIG.ON_OFF_STATE[resp[1]]
							this.setVariableValues({ muteState: tmp })
							this.checkFeedbacks('muteState')
							break
						case '%2FREZ':
							this.projector.freezeState = resp
							this.setVariableValues({ freezeState: CONFIG.ON_OFF_STATE[resp] })
							this.checkFeedbacks('freezeState')
							break
						case '%2SNUM':
							this.projector.serialNumber = resp
							this.setVariableValues({ serialNumber: resp })
							break
						case '%2SVER':
							this.projector.softwareVer = resp
							this.setVariableValues({ softwareVer: resp })
							break
						case '%2FILT':
							this.projector.filterUsageTime = resp
							this.setVariableValues({ filterUsageTime: resp })
							break
					}
				}

				if (this.commands.length) {
					if (this.lastCmd != data.slice(0, 6)) {
						this.log('debug', `Response mismatch, expected ${this.lastCmd}`)
					}
					let nextCmd = this.commands.shift()
					if (this.DebugLevel >= 1) {
						this.log('debug', `PJLINK: > ${nextCmd}`)
					}
					this.lastCmd = nextCmd.slice(0, 6)
					await this.socket?.send(this.passwordstring + nextCmd + '\r')
				} else {
					if (this.socketTimer) {
						clearInterval(this.socketTimer)
						delete this.socketTimer
					}

					this.socketTimer = setInterval(async () => {
						// socket isn't connected, abort
						if (this.socket === undefined || !this.socket?.isConnected) {
							return
						}
						if (this.commands.length > 0) {
							let cmd = this.commands.shift()
							this.connect_time = Date.now()
							this.lastCmd = cmd.slice(0, 6)
							await this.socket.send(this.passwordstring + cmd + '\r')
							clearInterval(this.socketTimer)
							delete this.socketTimer
						}

						// istnv: an old version of the documentation stated 4 seconds.
						//		Reading through version 1.04 and version 2.00,
						//		idle time is 30 seconds

						if (Date.now() - this.connect_time > 30000) {
							if (this.socketTimer) {
								clearInterval(this.socketTimer)
								delete this.socketTimer
							}
							if (this.socket !== undefined && this.socket.destroy !== undefined) {
								this.socket.destroy()
							}

							delete this.socket
							this.pjConnected = false
							this.authOK = false

							this.log('debug', 'disconnecting per protocol defintion :(')
						}
					}, 100)
				}
			})

			this.socket.connect()
		}
	}

	async sendCmd(cmd) {
		let sent = true

		if (this.DebugLevel >= 1) {
			this.log('debug', `PJLINK: >> ${stamp()} ${cmd}`)
		}
		if (this.DebugLevel >= 2) {
			if (this.commands.length > 0) {
				this.log('debug', `this.commands is ${this.commands}`)
			}
		}

		if (this.badPassword) {
			return
		} else if (!this.authOK) {
			sent = false
		} else if (this.pjConnected) {
			try {
				await this.socket.send(this.passwordstring + cmd + '\r')
			} catch (error) {
				// connected but not ready :/
				if (error.code == 'EPIPE') {
					sent = false
				}
			}
		}
		if (!sent && !this.commands.includes(cmd)) {
			this.commands.push(cmd)
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
			{
				type: 'checkbox',
				id: 'debug',
				label: 'Enable extra debugging information',
				default: false,
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
			volumeUp: {
				name: 'Speaker Volume - Increase by 1',
			},
			volumeDown: {
				name: 'Speaker Volume - Decrease by 1',
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
			case 'volumeUp':
				cmd = '%1SVOL 1'
				break
			case 'volumeDown':
				cmd = '%1SVOL 0'
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
					return this.projector[feedback.options.error] == feedback.options.errorState
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
					return this.projector.freezeState == feedback.options.freezeState
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
					let item = this.projector.muteState[0] & feedback.options.item ? 1 : 0
					let stat = this.projector.muteState[1] == feedback.options.opt ? 1 : 0
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
						choices: this.projector.inputNames,
					},
				],
				callback: (feedback, context) => {
					return this.projector.inputNum == feedback.options.inputNum
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
					return this.projector.powerState === feedback.options.powerState
				},
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	async getProjectorDetails() {
		//Query Projector Class
		await this.sendCmd('%1CLSS ?')
		//	await this.sendCmd('%1AVMT ?')

		//Projector Class dependant initial queries
		this.socket.on('projectorClass', async () => {
			//any class

			//Query Projector Name
			await this.sendCmd('%1NAME ?')
			//Query Projector Manufacturer
			await this.sendCmd('%1INF1 ?')
			//Query Projector Product Name
			await this.sendCmd('%1INF2 ?')
			//Query Projector Product Name
			await this.sendCmd('%1INFO ?')

			if (this.projector.powerState === '1' && this.needInputs) {
				await this.sendCmd(`%${this.projector.class}INST ?`)
			}

			if (this.projector.class === '2') {
				//Query Serial Number
				await this.sendCmd('%2SNUM ?')
				//Query Software Version
				await this.sendCmd('%2SVER ?')
				//Query Lamp Replacement
				await this.sendCmd('%2RLMP ?')
				//Query Filter Replacement
				await this.sendCmd('%2RFIL ?')
				//Query Recommended Resolution
				await this.sendCmd('%2RRES ?')
			}
		})
	}

	async poll() {
		let checkHours = false

		// don't reset until password fixed
		if (this.badPassword) {
			return
		}

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
		// resend passcode if using

		//Query Power
		await this.sendCmd('%1POWR ?')
		//Query Error Status
		await this.sendCmd('%1ERST ?')

		//Query Lamp
		// -- I was going to add this to the 10 minute check
		// -- but the response includes the lamp on status
		// Laser PJ does not have a 'lamp'
		if (!this.projector.isLaser) {
			await this.sendCmd('%1LAMP ?')
		}

		//Query Mute Status and input (only valid if PJ is on)
		if (this.projector.powerState == '1') {
			await this.sendCmd('%1AVMT ?')
			await this.sendCmd(`%${this.projector.class}INPT ?`)

			if (this.needInputs) {
				await this.sendCmd(`%${this.projector.class}INST ?`)
			}
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
