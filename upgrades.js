module.exports = {
	upgrade_choices: function (context, config, actions, feedbacks) {
		let changed = false

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
}
