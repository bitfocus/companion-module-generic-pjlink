import { CreateConvertToBooleanFeedbackUpgradeScript } from '@companion-module/base'

export const UpgradeScripts = [
	function(context, props) {
		const result = {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}

		if (props.config) {
			if (props.config.pollTime == undefined || '' == props.config.pollTime) {
				props.config.pollTime = 10
				result.updatedConfig = props.config
			}
		}

		for (let action of props.actions) {
			let changed = false
			switch (action.actionId) {
				case 'powerOn':
					{
						action.actionId = 'powerState'
						action.options.opt = '1'
						changed = true
					}
					break
				case 'powerOff':
					{
						action.actionId = 'powerState'
						action.options.opt = '0'
						changed = true
					}
					break
				case 'shutterOpen':
					{
						action.actionId = 'muteState'
						action.options.opt = '30'
						changed = true
					}
					break
				case 'shutterClose':
					{
						action.actionId = 'muteState'
						action.options.opt = '31'
						changed = true
					}
					break
				case 'freeze':
					{
						action.actionId = 'freezeState'
						action.options.opt = '1'
						changed = true
					}
					break
				case 'unfreeze':
					{
						action.actionId = 'freezeState'
						action.options.opt = '0'
						changed = true
					}
					break
			}
			if (changed) {
				result.updatedActions.push(action)
			}
		}
		return result
	},

	function (context,props) { // was broken in original upgradescipts
		const result = {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}
		return result
	},

	function (context, props) {
		const result = {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}

		for (let action of props.actions) {
			let changed = false
			if ('muteState' == action.actionId) {
				if (action.options.opt.length == 2) {
					action.options.opt = action.options.opt.slice(1, 2)
					action.options.item = action.options.opt.slice(0, 1)
					changed = true
				} else if (action.options.item == undefined) {
					action.options.item = '3'
					changed = true
				}
			}
			if (changed) {
				result.updatedActions.push(action)
			}
		}


		for (let fb of props.feedbacks) {
			if ('muteState' == fb.feedbackId) {
				if (fb.options.muteState) {
					fb.options.item = fb.options.muteState.slice(0, 1)
					fb.options.opt = fb.options.muteState.slice(1, 2)
				}
				delete fb.options.muteState
				result.updatedFeedbacks.push(fb)
			}
		}
		return result
	}
]
