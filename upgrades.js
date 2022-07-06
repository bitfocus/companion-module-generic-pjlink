const action = require("../../lib/action")

module.exports = {
	upgrade_choices: function (context, config, actions, feedbacks) {
		let changed = false

		if (config.pollTime == undefined || config.pollTime == '') {
			config.pollTime = 10
			changed = true
		}

		actions.forEach((action) => {
			switch (action.action) {
				case 'powerOn':
					{
						action.action = 'powerState'
						action.options.opt = '1'
						changed = true
					}
					break
				case 'powerOff':
					{
						action.action = 'powerState'
						action.options.opt = '0'
						changed = true
					}
					break
				case 'shutterOpen':
					{
						action.action = 'muteState'
						action.options.opt = '30'
						changed = true
					}
					break
				case 'shutterClose':
					{
						action.action = 'muteState'
						action.options.opt = '31'
						changed = true
					}
					break
				case 'freeze':
					{
						action.action = 'freezeState'
						action.options.opt = '1'
						changed = true
					}
					break
				case 'unfreeze':
					{
						action.action = 'freezeState'
						action.options.opt = '0'
						changed = true
					}
					break
			}
		})
		return changed // if something changed
	},
	upgrade_muteaction: function (context, config, actions, feedbacks) {
		let changed = false

		actions.forEach((action) => {
			if ('muteState' == action.action && action.options.opt.slice(0,1)=='3') {
				action.options.opt = action.options.opt.slice(1,2)
				changed = true
			}
		})
		return changed
	}
}
